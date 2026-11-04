// Mixxx side of the djing agent: executes commands received on the virtual MIDI
// port and streams the decks' state back to it. Tables come from
// djing-agent-protocol.js, generated from agent/protocol.py.

/* global engine, midi, DjingAgentProtocol */

var DjingAgent = {}; // "var": Mixxx resolves "DjingAgent.cmd" on the global object

DjingAgent.connections = [];
DjingAgent.pendingMsb = {};

DjingAgent.init = function() {
    var P = DjingAgentProtocol;
    P.feedback.forEach(function(f) {
        var conn = engine.makeConnection(f.group, f.key, function(value) {
            DjingAgent.sendFeedback(f, value);
        });
        if (conn) {
            DjingAgent.connections.push(conn);
            conn.trigger(); // push the current state right away
        }
    });
    midi.sendShortMsg(0x90 | P.masterChannel, P.helloNote, 0x7F);
};

DjingAgent.shutdown = function() {
    DjingAgent.connections.forEach(function(c) { c.disconnect(); });
    DjingAgent.connections = [];
    midi.sendShortMsg(0x90 | DjingAgentProtocol.masterChannel, DjingAgentProtocol.helloNote, 0x00);
};

DjingAgent.clamp = function(v, max) {
    return Math.max(0, Math.min(max, Math.round(v)));
};

DjingAgent.sendFeedback = function(f, value) {
    if (f.kind === "note") {
        midi.sendShortMsg(0x90 | f.ch, f.num, value ? 0x7F : 0x00);
        return;
    }
    var v = f.param ? engine.getParameter(f.group, f.key) : value * f.scale;
    if (f.kind === "cc14") {
        var n = DjingAgent.clamp(f.param ? v * 16383 : v, 16383);
        midi.sendShortMsg(0xB0 | f.ch, f.num, n >> 7);
        midi.sendShortMsg(0xB0 | f.ch, f.num + DjingAgentProtocol.lsbOffset, n & 0x7F);
    } else {
        midi.sendShortMsg(0xB0 | f.ch, f.num, DjingAgent.clamp(f.param ? v * 127 : v, 127));
    }
};

// Every mapped message lands here (script-binding).
DjingAgent.cmd = function(channel, control, value, status, _group) {
    var P = DjingAgentProtocol;
    var kind = status & 0xF0;
    var ch = status & 0x0F;
    if (kind === 0x90 && ch === P.masterChannel && control === P.resyncNote && value > 0) {
        DjingAgent.connections.forEach(function(c) { c.trigger(); });
        midi.sendShortMsg(0x90 | P.masterChannel, P.helloNote, 0x7F);
        return;
    }
    if (kind === 0x90 || kind === 0x80) {
        var note = P.notes[ch + ":" + control];
        if (!note) { return; }
        var on = (kind === 0x90) && value > 0;
        if (note.mode === "trigger") {
            if (on) {
                engine.setValue(note.group, note.key, 1);
                engine.setValue(note.group, note.key, 0);
            }
        } else {
            engine.setValue(note.group, note.key, on ? 1 : 0);
        }
    } else if (kind === 0xB0) {
        if (control >= P.lsbOffset && control < 2 * P.lsbOffset) {
            var msbKey = ch + ":" + (control - P.lsbOffset);
            var cc14 = P.ccs[msbKey];
            var msb = DjingAgent.pendingMsb[msbKey];
            if (!cc14 || msb === undefined) { return; }
            delete DjingAgent.pendingMsb[msbKey];
            DjingAgent.apply(cc14, ((msb << 7) | value) / 16383);
        } else {
            var key = ch + ":" + control;
            var cc = P.ccs[key];
            if (!cc) { return; }
            if (cc.bits === 14) {
                DjingAgent.pendingMsb[key] = value;
            } else {
                DjingAgent.apply(cc, value / 127);
            }
        }
    }
};

DjingAgent.apply = function(cc, v01) {
    if (cc.param) {
        engine.setParameter(cc.group, cc.key, v01);
    } else {
        engine.setValue(cc.group, cc.key, cc.min + v01 * (cc.max - cc.min));
    }
};
