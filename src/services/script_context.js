const log = require('./log');
const notes = require('./notes');
const sql = require('./sql');
const utils = require('./utils');
const labels = require('./labels');
const date_notes = require('./date_notes');
const config = require('./config');
const repository = require('./repository');
const axios = require('axios');

function ScriptContext(startNote, allNotes) {
    this.modules = {};
    this.notes = utils.toObject(allNotes, note => [note.noteId, note]);
    this.apis = utils.toObject(allNotes, note => [note.noteId, new ScriptApi(startNote, note)]);
    this.require = moduleNoteIds => {
        return moduleName => {
            const candidates = allNotes.filter(note => moduleNoteIds.includes(note.noteId));
            const note = candidates.find(c => c.title === moduleName);

            if (!note) {
                throw new Error("Could not find module note " + moduleName);
            }

            return this.modules[note.noteId].exports;
        }
    };
}

function ScriptApi(startNote, currentNote) {
    this.startNote = startNote;
    this.currentNote = currentNote;

    this.axios = axios;

    this.utils = {
        unescapeHtml: utils.unescapeHtml,
        isoDateTimeStr: utils.dateStr,
        isoDateStr: date => utils.dateStr(date).substr(0, 10)
    };

    this.getInstanceName = () => config.General ? config.General.instanceName : null;

    this.getNoteById = async function(noteId) {
        return await repository.getNote(noteId);
    };

    this.getNotesWithLabel = async function (attrName, attrValue) {
        return await labels.getNotesWithLabel(attrName, attrValue);
    };

    this.getNoteWithLabel = async function (attrName, attrValue) {
        const notes = await this.getNotesWithLabel(attrName, attrValue);

        return notes.length > 0 ? notes[0] : null;
    };

    this.createNote = async function(parentNoteId, title, content = "", extraOptions = {}) {
        return await notes.createNote(parentNoteId, title, content, extraOptions);
    };

    this.createLabel = labels.createLabel;

    this.updateEntity = repository.updateEntity;

    this.log = message => log.info(`Script ${currentNote.noteId}: ${message}`);

    this.getRootCalendarNoteId = date_notes.getRootCalendarNoteId;
    this.getDateNoteId = date_notes.getDateNoteId;

    this.transaction = sql.doInTransaction;
}

module.exports = ScriptContext;