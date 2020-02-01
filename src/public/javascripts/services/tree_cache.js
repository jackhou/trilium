import Branch from "../entities/branch.js";
import NoteShort from "../entities/note_short.js";
import Attribute from "../entities/attribute.js";
import server from "./server.js";
import {LoadResults} from "./load_results.js";
import NoteComplement from "../entities/note_complement.js";
import appContext from "./app_context.js";

/**
 * TreeCache keeps a read only cache of note tree structure in frontend's memory.
 * - notes are loaded lazily when unknown noteId is requested
 * - when note is loaded, all its parent and child branches are loaded as well. For a branch to be used, it's not must be loaded before
 * - deleted notes are present in the cache as well, but they don't have any branches. As a result check for deleted branch is done by presence check - if the branch is not there even though the corresponding note has been loaded, we can infer it is deleted.
 *
 * Note and branch deletions are corner cases and usually not needed.
 */
class TreeCache {
    constructor() {
        this.initializedPromise = this.loadInitialTree();
    }

    async loadInitialTree() {
        const {notes, branches, attributes} = await server.get('tree');

        // clear the cache only directly before adding new content which is important for e.g. switching to protected session

        /** @type {Object.<string, NoteShort>} */
        this.notes = {};

        /** @type {Object.<string, Branch>} */
        this.branches = {};

        /** @type {Object.<string, Attribute>} */
        this.attributes = {};

        /** @type {Object.<string, Promise<NoteComplement>>} */
        this.noteComplementPromises = {};

        this.addResp(notes, branches, attributes);
    }

    addResp(noteRows, branchRows, attributeRows) {
        for (const noteRow of noteRows) {
            const {noteId} = noteRow;

            const oldNote = this.notes[noteId];

            if (oldNote) {
                for (const childNoteId of oldNote.children) {
                    const childNote = this.notes[childNoteId];

                    if (childNote) {
                        childNote.parents = childNote.parents.filter(p => p !== noteId);

                        delete this.branches[childNote.parentToBranch[noteId]];
                        delete childNote.parentToBranch[noteId];
                    }
                }

                for (const parentNoteId of oldNote.parents) {
                    const parentNote = this.notes[parentNoteId];

                    if (parentNote) {
                        parentNote.children = parentNote.children.filter(p => p !== noteId);

                        delete this.branches[parentNote.childToBranch[noteId]];
                        delete parentNote.childToBranch[noteId];
                    }
                }
            }

            const note = new NoteShort(this, noteRow);

            this.notes[note.noteId] = note;
        }

        for (const branchRow of branchRows) {
            const branch = new Branch(this, branchRow);

            this.branches[branch.branchId] = branch;

            const childNote = this.notes[branch.noteId];

            if (childNote) {
                childNote.addParent(branch.parentNoteId, branch.branchId);
            }

            const parentNote = this.notes[branch.parentNoteId];

            if (parentNote) {
                parentNote.addChild(branch.noteId, branch.branchId);
            }
        }

        for (const attributeRow of attributeRows) {
            const {attributeId} = attributeRow;

            this.attributes[attributeId] = new Attribute(this, attributeRow);

            const note = this.notes[attributeRow.noteId];

            if (!note.attributes.includes(attributeId)) {
                note.attributes.push(attributeId);
            }

            if (attributeRow.type === 'relation') {
                const targetNote = this.notes[attributeRow.value];

                if (targetNote) {
                    if (!note.targetRelations.includes(attributeId)) {
                        note.targetRelations.push(attributeId);
                    }
                }
            }
        }
    }

    async reloadNotes(noteIds) {
        if (noteIds.length === 0) {
            return;
        }

        noteIds = Array.from(new Set(noteIds)); // make noteIds unique

        const resp = await server.post('tree/load', { noteIds });

        this.addResp(resp.notes, resp.branches, resp.attributes);

        for (const note of resp.notes) {
            if (note.type === 'search') {
                const searchResults = await server.get('search-note/' + note.noteId);

                if (!searchResults) {
                    throw new Error(`Search note ${note.noteId} failed.`);
                }

                // force to load all the notes at once instead of one by one
                await this.getNotes(searchResults.map(res => res.noteId));

                const branches = resp.branches.filter(b => b.noteId === note.noteId || b.parentNoteId === note.noteId);

                searchResults.forEach((result, index) => branches.push({
                    // branchId should be repeatable since sometimes we reload some notes without rerendering the tree
                    branchId: "virt" + result.noteId + '-' + note.noteId,
                    noteId: result.noteId,
                    parentNoteId: note.noteId,
                    prefix: this.getBranch(result.branchId).prefix,
                    notePosition: (index + 1) * 10
                }));

                // update this note with standard (parent) branches + virtual (children) branches
                this.addResp([note], branches, []);
            }
        }
    }

    /** @return {Promise<NoteShort[]>} */
    async getNotes(noteIds, silentNotFoundError = false) {
        const missingNoteIds = noteIds.filter(noteId => !this.notes[noteId]);

        await this.reloadNotes(missingNoteIds);

        return noteIds.map(noteId => {
            if (!this.notes[noteId] && !silentNotFoundError) {
                console.log(`Can't find note "${noteId}"`);

                return null;
            }
            else {
                return this.notes[noteId];
            }
        }).filter(note => !!note);
    }

    /** @return {Promise<boolean>} */
    async noteExists(noteId) {
        const notes = await this.getNotes([noteId], true);

        return notes.length === 1;
    }

    /** @return {Promise<NoteShort>} */
    async getNote(noteId, silentNotFoundError = false) {
        if (noteId === 'none') {
            console.log(`No 'none' note.`);
            return null;
        }
        else if (!noteId) {
            console.log(`Falsy noteId ${noteId}, returning null.`);
            return null;
        }

        return (await this.getNotes([noteId], silentNotFoundError))[0];
    }

    getNoteFromCache(noteId) {
        return this.notes[noteId];
    }

    getBranches(branchIds) {
        return branchIds
            .map(branchId => this.getBranch(branchId))
            .filter(b => b !== null);
    }

    /** @return {Branch} */
    getBranch(branchId, silentNotFoundError = false) {
        if (!(branchId in this.branches)) {
            if (!silentNotFoundError) {
                console.error(`Not existing branch ${branchId}`);
            }
        }
        else {
            return this.branches[branchId];
        }
    }

    async getBranchId(parentNoteId, childNoteId) {
        const child = await this.getNote(childNoteId);

        return child.parentToBranch[parentNoteId];
    }

    async getNoteComplement(noteId) {
        if (!this.noteComplementPromises[noteId]) {
            this.noteComplementPromises[noteId] = server.get('notes/' + noteId).then(row => new NoteComplement(row));
        }

        return await this.noteComplementPromises[noteId];
    }

    // FIXME does not actually belong here
    async processSyncRows(syncRows) {
        const loadResults = new LoadResults(this);

        syncRows.filter(sync => sync.entityName === 'notes').forEach(sync => {
            const note = this.notes[sync.entityId];

            if (note) {
                note.update(sync.entity);
                loadResults.addNote(sync.entityId, sync.sourceId);
            }
        });

        syncRows.filter(sync => sync.entityName === 'branches').forEach(sync => {
            let branch = this.branches[sync.entityId];
            const childNote = this.notes[sync.entity.noteId];
            const parentNote = this.notes[sync.entity.parentNoteId];

            if (branch) {
                if (sync.entity.isDeleted) {
                    if (childNote) {
                        childNote.parents = childNote.parents.filter(parentNoteId => parentNoteId !== sync.entity.parentNoteId);
                        delete childNote.parentToBranch[sync.entity.parentNoteId];
                    }

                    if (parentNote) {
                        parentNote.children = parentNote.children.filter(childNoteId => childNoteId !== sync.entity.noteId);
                        delete parentNote.childToBranch[sync.entity.noteId];
                    }
                }
                else {
                    branch.update(sync.entity);
                    loadResults.addBranch(sync.entityId, sync.sourceId);

                    if (childNote) {
                        childNote.addParent(branch.parentNoteId, branch.branchId);
                    }

                    if (parentNote) {
                        parentNote.addChild(branch.noteId, branch.branchId);
                    }
                }
            }
            else if (!sync.entity.isDeleted) {
                if (childNote || parentNote) {
                    branch = new Branch(this, sync.entity);
                    this.branches[branch.branchId] = branch;

                    loadResults.addBranch(sync.entityId, sync.sourceId);

                    if (childNote) {
                        childNote.addParent(branch.parentNoteId, branch.branchId);
                    }

                    if (parentNote) {
                        parentNote.addChild(branch.noteId, branch.branchId);
                    }
                }
            }
        });

        syncRows.filter(sync => sync.entityName === 'note_reordering').forEach(sync => {
            for (const branchId in sync.positions) {
                const branch = this.branches[branchId];

                if (branch) {
                    branch.notePosition = sync.positions[branchId];
                }
            }

            loadResults.addNoteReordering(sync.entityId, sync.sourceId);
        });

        // missing reloading the relation target note
        syncRows.filter(sync => sync.entityName === 'attributes').forEach(sync => {
            let attribute = this.attributes[sync.entityId];
            const sourceNote = this.notes[sync.entity.noteId];
            const targetNote = sync.entity.type === 'relation' && this.notes[sync.entity.value];

            if (attribute) {
                attribute.update(sync.entity);
                loadResults.addAttribute(sync.entityId, sync.sourceId);

                if (sync.entity.isDeleted) {
                    if (sourceNote) {
                        sourceNote.attributes = sourceNote.attributes.filter(attributeId => attributeId !== attribute.attributeId);
                    }

                    if (targetNote) {
                        targetNote.targetRelations = targetNote.targetRelations.filter(attributeId => attributeId !== attribute.value);
                    }
                }
            }
            else if (!sync.entity.isDeleted) {
                if (sourceNote || targetNote) {
                    attribute = new Attribute(this, sync.entity);

                    this.attributes[attribute.attributeId] = attribute;

                    loadResults.addAttribute(sync.entityId, sync.sourceId);

                    if (sourceNote && !sourceNote.attributes.includes(attribute.attributeId)) {
                        sourceNote.attributes.push(attribute.attributeId);
                    }

                    if (targetNote && !targetNote.attributes.includes(attribute.attributeId)) {
                        targetNote.attributes.push(attribute.attributeId);
                    }
                }
            }
        });

        syncRows.filter(sync => sync.entityName === 'note_contents').forEach(sync => {
            delete this.noteComplementPromises[sync.entityId];

            loadResults.addNoteContent(sync.entityId, sync.sourceId);
        });

        syncRows.filter(sync => sync.entityName === 'note_revisions').forEach(sync => {
            loadResults.addNoteRevision(sync.entityId, sync.noteId, sync.sourceId);
        });

        appContext.trigger('entitiesReloaded', {loadResults});
    }
}

const treeCache = new TreeCache();

export default treeCache;