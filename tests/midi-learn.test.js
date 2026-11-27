// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna; // logic.js is a classic script that reads the Luna global
await import('../logic.js');
const logic = globalThis.AddOnLogic;

const CC = (n, v, ch = 1) => logic.parseMidi([0xb0 | (ch - 1), n, v]);
const NOTE_ON = (n, v = 100, ch = 1) => logic.parseMidi([0x90 | (ch - 1), n, v]);
const NOTE_OFF = (n, ch = 1) => logic.parseMidi([0x80 | (ch - 1), n, 0]);
const PROGRAM = (n, ch = 1) => logic.parseMidi([0xc0 | (ch - 1), n]);

async function connected({ uid = 'abc', tracks = ['Vocal', 'Bass'], storage = logic.memoryStore(), engine = new Luna.MockEngine() } = {}) {
  engine.addSession(uid, { name: 'Demo', tracks, packageUid: `pkg_${uid}` });
  engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  await luna.plugins.load();
  const mapper = new logic.Mapper(session, {
    storage,
    subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
    pluginName: (id) => luna.plugins.byId(id)?.name.value,
  });
  await mapper.start();
  const settle = async () => {
    await mapper.settled();
    await engine.settled();
    await luna.settled();
  };
  return { engine, luna, session, mapper, storage, settle };
}

const gainOf = (session, name) => session.visibleTracks.find((t) => t.name.value === name).gain;

describe('parseMidi', () => {
  it('reads CC, notes, pitch bend and program change', () => {
    expect(CC(74, 127, 2)).toMatchObject({ type: 'cc', channel: 2, number: 74, value: 1 });
    expect(NOTE_ON(60)).toMatchObject({ type: 'note', number: 60, on: true });
    expect(logic.parseMidi([0x90, 60, 0])).toMatchObject({ type: 'note', on: false, value: 0 });
    expect(logic.parseMidi([0xe0, 0x7f, 0x7f])).toMatchObject({ type: 'pitch', value: 1 });
    expect(logic.parseMidi([0xf8])).toBeNull();
    expect(logic.sourceLabel({ type: 'note', number: 60 })).toBe('Note C3');
  });
});

describe('catalog', () => {
  it('lists strip controls for every track and the master, and plugins without reading their parameters', async () => {
    const { engine, session, mapper } = await connected();
    const vocal = session.visibleTracks[0];
    await vocal.insert('com.uaudio.uadx.1176');
    engine.requests.length = 0;
    await mapper.rescan();
    const labels = mapper.entries.filter((e) => e.channel === 'Vocal').map((e) => `${e.area}/${e.label}`);
    expect(labels).toEqual(expect.arrayContaining(['Strip/Fader', 'Strip/Mute', 'Strip/Solo']));
    expect(labels.some((l) => l.includes('1176'))).toBe(false);
    expect(mapper.inserts).toEqual([expect.objectContaining({ channel: 'Vocal', channelId: vocal.id, slot: 'effect_0', area: 'Insert 1 · UA 1176', pluginId: 'com.uaudio.uadx.1176', pluginName: 'UA 1176' })]);
    expect(engine.requests.some((r) => /\/effects\/[^/]+\/controls/.test(r.path))).toBe(false); // fact 101
    expect(mapper.entries.some((e) => e.channelId !== vocal.id && e.label === 'Fader')).toBe(true);
  });
});

describe('learn', () => {
  it('maps the control touched in LUNA to the knob moved next', async () => {
    const { engine, session, mapper, storage, settle } = await connected();
    const gain = gainOf(session, 'Bass');
    mapper.setLearning(true);
    engine.setValue(gain.path, 'touch_count', 1); // the user grabs Bass's fader in LUNA
    await settle();
    expect(mapper.pending.target).toMatchObject({ channel: 'Bass', label: 'Fader' });
    mapper.midi(CC(7, 64), 'nanoKONTROL');
    expect(mapper.learning).toBe(false);
    expect(mapper.rows()).toHaveLength(1);
    expect(mapper.rows()[0]).toMatchObject({ source: 'CC 7', target: 'Fader', where: 'Bass · Strip', device: 'nanoKONTROL' });
    expect(storage.get(logic.KEYS.session('pkg_abc'))).toHaveLength(1);
  });

  it('works the other way round: knob first, then a target picked in the add-on', async () => {
    const { mapper } = await connected();
    mapper.setLearning(true);
    mapper.midi(NOTE_ON(36), 'Pads');
    mapper.midi(NOTE_OFF(36), 'Pads');
    expect(mapper.pending.source).toMatchObject({ type: 'note', number: 36 });
    mapper.pick(logic.commandTarget('togglePlayback'));
    expect(mapper.rows()[0]).toMatchObject({ source: 'Note C1', target: 'Play / Stop', where: 'Command' });
    expect(mapper.rows()[0].mapping.mode).toBe('trigger');
  });

  it('learns a plugin parameter touched in LUNA by reading only that parameter', async () => {
    const { engine, session, mapper, settle } = await connected();
    const fx = await session.visibleTracks[0].insert('com.uaudio.uadx.1176');
    await mapper.rescan();
    const path = `${fx.path}/controls/input`;
    engine.requests.length = 0;
    mapper.setLearning(true);
    engine.setValue(path, 'touch_count', 1); // the user grabs the 1176's Input knob in its window
    await settle();
    await mapper.loading.get(path);
    await settle();
    expect(mapper.pending.target).toMatchObject({ channel: 'Vocal', area: 'Insert 1 · UA 1176', label: 'Input' });
    expect(engine.requests.filter((r) => r.verb === 'get' && r.path.includes('/effects/')).map((r) => r.path.split('?')[0])).toEqual([path]);
    mapper.midi(CC(21, 127), 'Ctl');
    mapper.midi(CC(21, 0), 'Ctl');
    await mapper.flush();
    await settle();
    expect(engine.value(path, 'normalized_value')).toBe(0);
  });

  it('works before the strip scan has finished', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { tracks: ['Vocal'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }) });
    const started = mapper.start();
    mapper.setLearning(true);
    mapper.midi(CC(1, 127), 'Ctl');
    mapper.pick(logic.commandTarget('play'));
    expect(mapper.rows()).toHaveLength(1);
    await started;
  });

  it('ignores touches outside learn mode', async () => {
    const { engine, session, mapper, settle } = await connected();
    engine.setValue(gainOf(session, 'Vocal').path, 'touch_count', 1);
    await settle();
    expect(mapper.pending.target).toBeUndefined();
  });

  it('learning a source again moves it to the new target', async () => {
    const { session, mapper } = await connected();
    const entry = (name) => mapper.entries.find((e) => e.channel === name && e.label === 'Fader');
    mapper.pick(logic.targetOf(entry('Vocal')));
    mapper.midi(CC(1, 10));
    mapper.pick(logic.targetOf(entry('Bass')));
    mapper.midi(CC(1, 20));
    expect(mapper.rows().map((r) => r.where)).toEqual(['Bass · Strip']);
    expect(session).toBeDefined();
  });
});

describe('applying MIDI', () => {
  async function mapped(label, track, source, mode) {
    const ctx = await connected();
    const entry = ctx.mapper.entries.find((e) => e.channel === track && e.label === label);
    ctx.mapper.pick(logic.targetOf(entry));
    ctx.mapper.midi(source, 'Ctl');
    if (mode) ctx.mapper.update(ctx.mapper.rows()[0].mapping.id, { mode });
    ctx.engine.touches.length = 0;
    return { ...ctx, entry };
  }

  it('drives a fader as one touched gesture and lands on the last value', async () => {
    const { engine, mapper, entry, settle } = await mapped('Fader', 'Vocal', CC(7, 0));
    for (const v of [10, 40, 80, 100]) mapper.midi(CC(7, v), 'Ctl');
    await mapper.flush();
    await settle();
    expect(engine.touches).toEqual([`${entry.path}:on`, `${entry.path}:off`]);
    expect(engine.value(entry.path, 'normalized_value')).toBeCloseTo(100 / 127, 5);
  });

  it('honours range and invert', async () => {
    const { engine, mapper, entry, settle } = await mapped('Fader', 'Vocal', CC(7, 0));
    mapper.update(mapper.rows()[0].mapping.id, { min: 0.2, max: 0.6, invert: true });
    mapper.midi(CC(7, 127), 'Ctl');
    await mapper.flush();
    await settle();
    expect(engine.value(entry.path, 'normalized_value')).toBeCloseTo(0.2, 5);
  });

  it('toggles a mute on each press and not on release', async () => {
    const { engine, mapper, entry, settle } = await mapped('Mute', 'Bass', NOTE_ON(40));
    mapper.midi(NOTE_ON(40), 'Ctl');
    await settle();
    mapper.midi(NOTE_OFF(40), 'Ctl');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(true);
    expect(engine.touches).toEqual([`${entry.path}:on`, `${entry.path}:off`]);
    mapper.midi(NOTE_ON(40), 'Ctl');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(false);
  });

  it('only listens to the device it learned from, unless set to any', async () => {
    const { engine, mapper, entry, settle } = await mapped('Mute', 'Bass', CC(20, 127));
    mapper.midi(CC(20, 0), 'Other');
    mapper.midi(CC(20, 127), 'Other');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(false);
    mapper.update(mapper.rows()[0].mapping.id, { source: { device: null } });
    mapper.midi(CC(20, 0), 'Other');
    mapper.midi(CC(20, 127), 'Other');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(true);
  });

  it('runs a command on the rising edge of a button', async () => {
    const { engine, mapper, settle } = await connected();
    mapper.pick(logic.commandTarget('togglePlayback'));
    mapper.midi(CC(41, 127), 'Ctl');
    mapper.midi(CC(41, 0), 'Ctl');
    mapper.midi(CC(41, 127), 'Ctl');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    mapper.midi(CC(41, 127), 'Ctl'); // held: no new edge
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('runs a command on every Note On even when the controller sends no Note Off', async () => {
    const { engine, mapper, settle } = await connected();
    mapper.pick(logic.commandTarget('togglePlayback'));
    mapper.midi(NOTE_ON(94, 127), 'MPK mini IV');
    mapper.midi(NOTE_ON(94, 127), 'MPK mini IV');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    mapper.midi(NOTE_ON(94, 127), 'MPK mini IV'); // 2nd press without Note Off
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(false);
    mapper.midi(NOTE_ON(94, 30), 'MPK mini IV'); // soft press (velocity < 64) still fires
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('runs a command on every Program Change message', async () => {
    const { engine, mapper, settle } = await connected();
    mapper.pick(logic.commandTarget('togglePlayback'));
    mapper.midi(PROGRAM(1), 'Ctl');
    mapper.midi(PROGRAM(1), 'Ctl');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    mapper.midi(PROGRAM(1), 'Ctl');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(false);
  });

  it('runs a command again on a one-shot CC button (127 with no 0 release) after a quiet gap', async () => {
    let clock = 1000;
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), now: () => clock });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
    };
    mapper.pick(logic.commandTarget('togglePlayback'));
    mapper.midi(CC(76, 127), 'MPK mini IV DAW Port');
    // 1st press
    clock += 500;
    mapper.midi(CC(76, 127), 'MPK mini IV DAW Port');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    // Rapid repeat (held button) does not re-trigger
    clock += 30;
    mapper.midi(CC(76, 127), 'MPK mini IV DAW Port');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    // 2nd press after a quiet gap triggers again even without CC 0
    clock += 300;
    mapper.midi(CC(76, 127), 'MPK mini IV DAW Port');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(false);
    // 3rd press also works
    clock += 300;
    mapper.midi(CC(76, 127), 'MPK mini IV DAW Port');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('toggles a switch on every Note On even without Note Off', async () => {
    const { engine, mapper, entry, settle } = await mapped('Mute', 'Bass', NOTE_ON(40, 127));
    mapper.midi(NOTE_ON(40, 127), 'Ctl');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(true);
    mapper.midi(NOTE_ON(40, 127), 'Ctl');
    await settle();
    expect(engine.value(entry.path, 'real_value')).toBe(false);
  });

  it('does not take its own touches for a target while learning', async () => {
    const { engine, mapper, entry, settle } = await mapped('Fader', 'Vocal', CC(7, 0));
    mapper.midi(CC(7, 90), 'Ctl');
    await settle();
    mapper.setLearning(true);
    engine.setValue(entry.path, 'touch_count', 2);
    await settle();
    expect(mapper.pending.target).toBeUndefined();
    await mapper.flush();
  });
});

describe('persistence', () => {
  it('keeps session mappings per session and globals everywhere', async () => {
    const storage = logic.memoryStore();
    const engine = new Luna.MockEngine();
    const a = await connected({ storage, engine });
    a.mapper.pick(logic.commandTarget('play'));
    a.mapper.midi(CC(1, 127));
    a.mapper.pick(logic.targetOf(a.mapper.entries.find((e) => e.label === 'Fader')));
    a.mapper.midi(CC(2, 127));
    a.mapper.update(a.mapper.rows()[0].mapping.id, { scope: 'global' });

    const again = new logic.Mapper(a.session, { storage });
    await again.start();
    expect(again.rows()).toHaveLength(2);

    const b = await connected({ uid: 'other', storage, engine: new Luna.MockEngine() });
    expect(b.mapper.rows().map((r) => [r.target, r.global])).toEqual([['Play', true]]);
  });

  it('applies a template in another session by track and control name', async () => {
    const storage = logic.memoryStore();
    const a = await connected({ storage });
    a.mapper.pick(logic.targetOf(a.mapper.entries.find((e) => e.channel === 'Bass' && e.label === 'Fader')));
    a.mapper.midi(CC(7, 0));
    a.mapper.saveTemplate('nanoKONTROL');
    expect(a.mapper.templates().map((t) => t.name)).toEqual(['nanoKONTROL']);

    const b = await connected({ uid: 'xyz', tracks: ['Drums', 'Bass'], storage, engine: new Luna.MockEngine() });
    expect(b.mapper.applyTemplate('nanoKONTROL')).toBe(1);
    const row = b.mapper.rows()[0];
    expect(row.missing).toBe(false);
    expect(row.entry.channelId).toBe(b.session.visibleTracks.find((t) => t.name.value === 'Bass').id);

    const c = await connected({ uid: 'q', tracks: ['Keys'], storage, engine: new Luna.MockEngine() });
    c.mapper.applyTemplate('nanoKONTROL');
    expect(c.mapper.rows()[0].missing).toBe(true);
  });

  it('exports and imports templates and globals', async () => {
    const a = await connected();
    a.mapper.pick(logic.commandTarget('undo'));
    a.mapper.midi(CC(9, 127));
    a.mapper.saveTemplate('Undo pad');
    a.mapper.update(a.mapper.rows()[0].mapping.id, { scope: 'global' });
    const doc = JSON.parse(JSON.stringify(a.mapper.exportAll()));
    const b = await connected({ engine: new Luna.MockEngine() });
    b.mapper.importAll(doc);
    expect(b.mapper.templates().map((t) => t.name)).toEqual(['Undo pad']);
    expect(b.mapper.rows()[0]).toMatchObject({ target: 'Undo', global: true });
    expect(() => b.mapper.importAll({})).toThrow();
  });
});

describe('typed-in sources', () => {
  it('parses CC, notes by number or name, pitch bend and any channel', () => {
    expect(logic.manualSource({ type: 'cc', number: '100', channel: '' })).toEqual({ device: null, type: 'cc', channel: null, number: 100 });
    expect(logic.manualSource({ type: 'note', number: 'C3', channel: 10 })).toMatchObject({ number: 60, channel: 10 });
    expect(logic.manualSource({ type: 'note', number: 'F#1', channel: '' })).toMatchObject({ number: 42 });
    expect(logic.manualSource({ type: 'pitch', number: '', channel: 1 })).toMatchObject({ type: 'pitch', number: 0 });
    expect(logic.manualSource({ type: 'cc', number: '128' })).toBeUndefined();
    expect(logic.manualSource({ type: 'cc', number: 'abc' })).toBeUndefined();
    expect(logic.manualSource({ type: 'cc', number: '7', channel: 17 })).toBeUndefined();
  });

  it('maps a command to a typed CC, which then fires from any channel and input', async () => {
    const { engine, mapper, settle } = await connected();
    mapper.pick(logic.commandTarget('togglePlayback'));
    expect(mapper.assign(logic.manualSource({ type: 'cc', number: '100', channel: '' }))).toBe(true);
    expect(mapper.rows()[0]).toMatchObject({ source: 'CC 100', target: 'Play / Stop' });
    mapper.midi(CC(100, 127, 3), 'Roto-Control');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('a typed source waits for a target when none is picked yet', async () => {
    const { mapper } = await connected();
    expect(mapper.assign(logic.manualSource({ type: 'cc', number: '20' }))).toBe(false);
    mapper.pick(logic.commandTarget('stop'));
    expect(mapper.rows()[0]).toMatchObject({ source: 'CC 20', target: 'Stop' });
  });

  it('editing a mapping onto another mapping\'s source replaces that one', async () => {
    const { mapper } = await connected();
    mapper.pick(logic.commandTarget('play'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '1' }));
    mapper.pick(logic.commandTarget('stop'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '2' }));
    const stop = mapper.rows().find((r) => r.target === 'Stop').mapping;
    mapper.update(stop.id, { source: { number: 1 } });
    expect(mapper.rows().map((r) => `${r.source} ${r.target}`)).toEqual(['CC 1 Stop']);
  });
});

describe('vendored SDK bundle', () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const bundle = read('vendor/luna.global.js');

  it('is the SDK version the manifest names', () => {
    const context = vm.createContext({});
    vm.runInContext(bundle, context);
    expect(vm.runInContext('Luna.VERSION', context)).toBe(JSON.parse(read('manifest.json')).sdk_version);
  });

  it('carries the load-retry patch', () => {
    // patches/ua-builder-sdk-load-retry.patch: Node, Collection and Session forget a failed load.
    expect(bundle.match(/if \(this\.loading === loading\) this\.loading = void 0;/g)).toHaveLength(2);
    expect(bundle).toContain('if (this.readyPromise !== ready) return;');
  });

  it('is kept by npm run pack', () => {
    // ua-builder pack replaces vendor/luna.global.js with the unpatched bundle unless told not to.
    expect(JSON.parse(read('package.json')).scripts.pack).toBe('ua-builder pack --no-vendor');
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  it('carries name and title, so LUNA builds before and after the rename both show it', () => {
    expect(manifest).toMatchObject({ name: 'MIDI Learn', title: 'MIDI Learn' });
  });

  it('names its manufacturer for Settings > Add Ons', () => {
    expect(manifest.manufacturer).toBe('No Humans');
  });
});

describe('feedback to motorized controllers', () => {
  async function withFeedback({ feedback = true, holdMs = 30, source = CC(7, 0) } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const sent = [];
    const mapper = new logic.Mapper(session, {
      storage: logic.memoryStore(),
      subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
      send: (device, bytes) => (sent.push({ device, bytes }), true),
      feedbackHoldMs: holdMs,
    });
    await mapper.start();
    const entry = mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader');
    mapper.pick(logic.targetOf(entry));
    mapper.midi(source, 'Roto-Control');
    const id = mapper.rows()[0].mapping.id;
    if (feedback) mapper.update(id, { feedback: true });
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
    };
    await settle();
    sent.length = 0;
    return { engine, luna, session, mapper, entry, id, sent, settle, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };
  }

  it('sends nothing unless a mapping turns feedback on', async () => {
    const { engine, entry, sent, settle } = await withFeedback({ feedback: false });
    engine.setValue(entry.path, 'normalized_value', 0.5);
    await settle();
    expect(sent).toEqual([]);
  });

  it('sends a value LUNA moves to back to the controller it was learned from', async () => {
    const { engine, entry, sent, settle } = await withFeedback();
    engine.setValue(entry.path, 'normalized_value', 0.5); // automation or a mouse in LUNA
    await settle();
    expect(sent).toEqual([{ device: 'Roto-Control', bytes: [0xb0, 7, 64] }]);
    engine.setValue(entry.path, 'normalized_value', 0.5); // same value: nothing new
    await settle();
    expect(sent).toHaveLength(1);
  });

  it('turning the knob sends nothing back until the hand lets go, and then only a correction', async () => {
    const { mapper, sent, settle, wait } = await withFeedback({ holdMs: 40 });
    for (const v of [10, 30, 60, 90]) mapper.midi(CC(7, v), 'Roto-Control');
    await settle();
    expect(sent).toEqual([]); // no fighting the hand
    await mapper.flush();
    await settle();
    await wait(120);
    await settle();
    // LUNA ended where the knob is, so there is nothing to correct.
    expect(sent).toEqual([]);
  });

  it('does not apply the motor echo of a value it sent', async () => {
    const { engine, mapper, entry, sent, settle } = await withFeedback();
    engine.setValue(entry.path, 'normalized_value', 100 / 127);
    await settle();
    expect(sent.at(-1).bytes).toEqual([0xb0, 7, 100]);
    engine.touches.length = 0;
    mapper.midi(CC(7, 100), 'Roto-Control'); // the knob reports where its motor went
    mapper.midi(CC(7, 101), 'Roto-Control'); // ±1 jitter is an echo too
    await mapper.flush();
    await settle();
    expect(engine.touches).toEqual([]); // nothing written back to LUNA
  });

  it('honours the range and invert when sending back', async () => {
    const { engine, mapper, entry, id, sent, settle } = await withFeedback();
    mapper.update(id, { min: 0.2, max: 0.6, invert: true });
    await settle();
    sent.length = 0;
    engine.setValue(entry.path, 'normalized_value', 0.2); // the bottom of the range, inverted
    await settle();
    expect(sent.at(-1).bytes).toEqual([0xb0, 7, 127]);
  });

  it('sends a switch as 0 or 127, and a note-mapped switch as note on or off', async () => {
    const { engine, mapper, session, sent, settle } = await withFeedback();
    const mute = mapper.entries.find((e) => e.channel === 'Bass' && e.label === 'Mute');
    mapper.pick(logic.targetOf(mute));
    mapper.midi(NOTE_ON(40, 100, 2), 'Roto-Control');
    const noteId = mapper.rows().find((r) => r.target === 'Mute').mapping.id;
    mapper.update(noteId, { feedback: true });
    await settle();
    sent.length = 0;
    await session.visibleTracks.find((t) => t.name.value === 'Bass').mute.toggle(); // muted in LUNA
    await settle();
    expect(sent).toContainEqual({ device: 'Roto-Control', bytes: [0x91, 40, 127] });
  });

  it('sends to the input a mapping was heard on when it listens to any input', async () => {
    const { engine, mapper, entry, id, sent, settle, wait } = await withFeedback();
    mapper.update(id, { source: { device: null } });
    mapper.midi(CC(7, 5), 'Other Box');
    await mapper.flush();
    await settle();
    sent.length = 0;
    engine.setValue(entry.path, 'normalized_value', 1);
    await settle();
    expect(sent).toEqual([]); // still inside the hold after the knob moved
    await wait(80);
    expect(sent.at(-1)).toEqual({ device: 'Other Box', bytes: [0xb0, 7, 127] });
  });
});

describe('editing a mapping', () => {
  it('keeps its place in the list when toggled', async () => {
    const { mapper } = await connected();
    for (const [cmd, cc] of [['play', '1'], ['stop', '2'], ['undo', '3']]) {
      mapper.pick(logic.commandTarget(cmd));
      mapper.assign(logic.manualSource({ type: 'cc', number: cc }));
    }
    const order = () => mapper.rows().map((r) => r.target).join(',');
    expect(order()).toBe('Play,Stop,Undo');
    const stop = mapper.rows()[1].mapping;
    mapper.update(stop.id, { invert: true });
    mapper.update(stop.id, { mode: 'trigger' });
    mapper.update(stop.id, { source: { channel: 2 } });
    expect(order()).toBe('Play,Stop,Undo');
  });
});

describe('Channel Focus', () => {
  async function focusSetup({ send } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: 'pkg_abc' });
    engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const mapper = new logic.Mapper(session, {
      storage: logic.memoryStore(),
      subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
      pluginName: (id) => luna.plugins.byId(id)?.name.value,
      send,
      feedbackHoldMs: 20,
    });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
    };
    const focus = async (id) => {
      engine.setValue('/sessions/abc/contexts/main', 'last_selected_track', id);
      await settle();
      await Promise.all([...mapper.loading.values()]);
      await settle();
    };
    const gain = (name) => `/sessions/abc/tracks/${name}/outputs/main/controls/gain`;
    return { engine, luna, session, mapper, settle, focus, gain };
  }

  it('learns a fader by touch on any track, then drives whichever track has the focus', async () => {
    const { engine, mapper, settle, focus, gain } = await focusSetup();
    await focus('Vocal');
    mapper.setLearning(true, 'focus');
    engine.setValue(gain('Keys'), 'touch_count', 1); // touched on another track: still "the fader"
    await settle();
    await Promise.all([...mapper.loading.values()]);
    mapper.midi(CC(7, 0), 'Roto-Control');
    const row = mapper.rows()[0];
    expect(row).toMatchObject({ focus: true, target: 'Fader', where: 'Strip', missing: false });
    expect(mapper.sessionMappings).toEqual([]); // not a regular mapping
    mapper.midi(CC(7, 127), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(gain('Vocal'), 'normalized_value')).toBe(1);
    await focus('Bass');
    mapper.midi(CC(7, 0), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(gain('Bass'), 'normalized_value')).toBe(0);
    expect(engine.value(gain('Vocal'), 'normalized_value')).toBe(1); // left alone
  });

  it('drives a plugin parameter only where the same plugin sits in the same slot', async () => {
    const { engine, session, mapper, settle, focus } = await focusSetup();
    const [vocal, bass] = session.visibleTracks;
    const fxVocal = await vocal.insert('com.uaudio.uadx.1176');
    const fxBass = await bass.insert('com.uaudio.uadx.1176');
    await mapper.rescan();
    await focus('Vocal');
    mapper.setLearning(true, 'focus');
    engine.setValue(`${fxVocal.path}/controls/input`, 'touch_count', 1);
    await settle();
    await Promise.all([...mapper.loading.values()]);
    await settle();
    expect(mapper.pending.target).toMatchObject({ kind: 'focus', rest: 'effects/effect_0/controls/input' });
    mapper.midi(CC(21, 0), 'Roto-Control');
    expect(mapper.rows()[0]).toMatchObject({ focus: true, target: 'Input', where: 'Insert 1 · UA 1176' });
    await focus('Bass');
    mapper.midi(CC(21, 127), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(`${fxBass.path}/controls/input`, 'normalized_value')).toBe(1);
    await focus('Keys'); // no 1176 on Keys
    expect(mapper.rows()[0]).toMatchObject({ missing: true, missingWhy: 'not on Keys' });
    engine.requests.length = 0;
    mapper.midi(CC(21, 0), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.requests.some((r) => r.verb === 'set')).toBe(false);
  });

  it('sends the newly focused track\'s values back to motorized knobs', async () => {
    const sent = [];
    const { engine, mapper, settle, focus, gain } = await focusSetup({ send: (d, b) => (sent.push({ d, b }), true) });
    await focus('Vocal');
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader')));
    mapper.midi(CC(7, 0), 'Roto-Control');
    mapper.update(mapper.rows()[0].mapping.id, { feedback: true });
    engine.setValue(gain('Bass'), 'normalized_value', 0.25);
    await settle();
    sent.length = 0;
    await focus('Bass');
    await new Promise((r) => setTimeout(r, 40));
    expect(sent.at(-1)).toEqual({ d: 'Roto-Control', b: [0xb0, 7, 32] });
  });

  it('a source belongs to one mapping across regular and focus mappings', async () => {
    const { mapper, focus } = await focusSetup();
    await focus('Vocal');
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(9, 127), 'Ctl');
    expect(mapper.sessionMappings).toHaveLength(1);
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.label === 'Mute')));
    mapper.midi(CC(9, 127), 'Ctl');
    expect(mapper.sessionMappings).toHaveLength(0);
    expect(mapper.focusMappings).toHaveLength(1);
  });

  it('can hold the focus on one track instead of following the selection', async () => {
    const { engine, mapper, settle, focus, gain } = await focusSetup();
    await focus('Vocal');
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader')));
    mapper.midi(CC(7, 0), 'Ctl');
    mapper.setFocusLock('Keys');
    await Promise.all([...mapper.loading.values()]);
    await focus('Bass'); // selection moves, the lock holds
    mapper.midi(CC(7, 127), 'Ctl');
    await mapper.flush();
    await settle();
    expect(engine.value(gain('Keys'), 'normalized_value')).toBe(1);
    expect(engine.value(gain('Bass'), 'normalized_value')).not.toBe(1);
  });

  it('commands cannot be focus-learned, and focus mappings export and import', async () => {
    const { mapper, focus } = await focusSetup();
    await focus('Vocal');
    mapper.setLearning(true, 'focus');
    expect(mapper.pick(logic.commandTarget('play'))).toBe(false);
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.label === 'Pan')));
    mapper.midi(CC(10, 64), 'Ctl');
    const doc = JSON.parse(JSON.stringify(mapper.exportAll()));
    expect(doc.focus).toHaveLength(1);
    const other = await focusSetup();
    other.mapper.importAll(doc);
    expect(other.mapper.focusMappings.map((m) => m.target.rest)).toEqual(['outputs/main/controls/pan']);
  });
});

describe('Proxy', () => {
  async function mightySetup() {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: 'pkg_abc' });
    engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const sent = [];
    const mapper = new logic.Mapper(session, {
      storage: logic.memoryStore(),
      subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
      pluginName: (id) => luna.plugins.byId(id)?.name.value,
      send: (d, b) => (sent.push({ d, b }), true),
      feedbackHoldMs: 20,
    });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await mapper.settled();
    };
    // The user clicks a control in LUNA: its touch_count rises, then falls on release.
    const click = async (path) => {
      engine.setValue(path, 'touch_count', 1);
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
    };
    const ctl = (track, id) => `/sessions/abc/tracks/${track}/outputs/main/controls/${id}`;
    mapper.setLearning(true, 'mighty');
    mapper.midi(CC(16, 0), 'Roto-Control');
    await settle();
    return { engine, session, mapper, sent, settle, click, ctl };
  }

  it('is learned from one knob, with feedback on', async () => {
    const { mapper } = await mightySetup();
    expect(mapper.mighty).toMatchObject({ source: { type: 'cc', number: 16 }, scope: 'mighty', feedback: true });
    expect(mapper.rows().find((r) => r.mighty)).toMatchObject({ target: 'Nothing yet', where: 'Click any control in LUNA' });
    expect(mapper.sessionMappings).toEqual([]);
  });

  it('drives whatever was clicked last in LUNA', async () => {
    const { engine, mapper, settle, click, ctl } = await mightySetup();
    await click(ctl('Vocal', 'gain'));
    expect(mapper.rows().find((r) => r.mighty)).toMatchObject({ target: 'Fader', where: 'Vocal · Strip' });
    mapper.midi(CC(16, 127), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(ctl('Vocal', 'gain'), 'normalized_value')).toBe(1);
    await click(ctl('Bass', 'pan'));
    mapper.midi(CC(16, 0), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(ctl('Bass', 'pan'), 'normalized_value')).toBe(0);
    expect(engine.value(ctl('Vocal', 'gain'), 'normalized_value')).toBe(1);
  });

  it('follows a plugin knob too, reading only that parameter', async () => {
    const { engine, session, mapper, settle, click } = await mightySetup();
    const fx = await session.visibleTracks[0].insert('com.uaudio.uadx.1176');
    await settle();
    engine.requests.length = 0;
    await click(`${fx.path}/controls/input`);
    expect(mapper.rows().find((r) => r.mighty)).toMatchObject({ target: 'Input', where: 'Vocal · Insert 1 · UA 1176' });
    expect(engine.requests.filter((r) => r.verb === 'get' && r.path.includes('/effects/')).map((r) => r.path.split('?')[0])).toEqual([`${fx.path}/controls/input`]);
  });

  it("sends the new target's value to the controller when it moves, so a motorized knob follows", async () => {
    const { engine, sent, click, ctl, settle } = await mightySetup();
    engine.setValue(ctl('Keys', 'gain'), 'normalized_value', 0.25);
    await settle();
    sent.length = 0;
    await click(ctl('Keys', 'gain'));
    expect(sent).toEqual([{ d: 'Roto-Control', b: [0xb0, 16, 32] }]);
  });

  it('is not moved by touches MIDI Learn makes itself', async () => {
    const { mapper, settle, click, ctl } = await mightySetup();
    await click(ctl('Vocal', 'gain'));
    // A regular mapping on another knob writes the Keys fader: that touch is ours, not the user's.
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Keys' && e.label === 'Fader')));
    mapper.midi(CC(7, 0), 'Roto-Control');
    mapper.midi(CC(7, 90), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(mapper.mightyPath).toBe(ctl('Vocal', 'gain'));
  });

  it('can hold its target, and gives up its knob to a regular mapping learned on it', async () => {
    const { mapper, click, ctl } = await mightySetup();
    await click(ctl('Vocal', 'gain'));
    mapper.setMightyHold(true);
    await click(ctl('Bass', 'gain'));
    expect(mapper.mightyPath).toBe(ctl('Vocal', 'gain'));
    mapper.setMightyHold(false);
    await click(ctl('Bass', 'gain'));
    expect(mapper.mightyPath).toBe(ctl('Bass', 'gain'));
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(16, 127), 'Roto-Control');
    expect(mapper.mighty).toBeNull();
  });
});

describe('track selection commands', () => {
  it('select next and previous track move the focus, stopping at the ends', async () => {
    const { engine, session, mapper, settle } = await connected({ tracks: ['Vocal', 'Bass', 'Keys'] });
    const focus = () => session.focusedTrack.value?.name.value;
    for (const [cmd, cc] of [['selectNextTrack', '1'], ['selectPreviousTrack', '2']]) {
      mapper.pick(logic.commandTarget(cmd));
      mapper.assign(logic.manualSource({ type: 'cc', number: cc }));
    }
    expect(mapper.rows().map((r) => r.target)).toEqual(['Select next track', 'Select previous track']);
    const press = async (cc) => {
      mapper.midi(CC(cc, 127), 'Ctl');
      mapper.midi(CC(cc, 0), 'Ctl');
      await settle();
    };
    expect(focus()).toBe('Vocal');
    await press(1);
    expect(focus()).toBe('Bass');
    expect(engine.value('/sessions/abc/contexts/main', 'selection_tracks')).toEqual(['Bass']);
    await press(1);
    await press(1); // already the last track
    expect(focus()).toBe('Keys');
    await press(2);
    expect(focus()).toBe('Bass');
  });
});

describe('automation modes', () => {
  async function autoSetup({ send } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), send, feedbackHoldMs: 20 });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
    };
    const track = (name) => session.visibleTracks.find((t) => t.name.value === name);
    const mode = (name) => engine.value(`/sessions/abc/tracks/${name}`, 'automation_mode');
    const press = async (cc) => {
      mapper.midi(CC(cc, 127), 'Roto-Control');
      mapper.midi(CC(cc, 0), 'Roto-Control');
      await settle();
    };
    const learn = (target, cc) => {
      mapper.pick(target);
      mapper.assign(logic.manualSource({ type: 'cc', number: String(cc), device: 'Roto-Control', channel: 1 }));
    };
    return { engine, session, mapper, settle, track, mode, press, learn };
  }

  it('a mode button sets that mode on its track', async () => {
    const { mapper, track, mode, press, learn } = await autoSetup();
    learn(logic.automationTarget(track('Bass'), 'touch'), 30);
    expect(mapper.rows()[0]).toMatchObject({ target: 'Automation Touch', where: 'Bass · Automation', automation: true });
    expect(mapper.rows()[0].mapping.mode).toBe('trigger');
    await press(30);
    expect(mode('Bass')).toBe('touch');
    expect(mode('Vocal')).not.toBe('touch');
  });

  it('next mode cycles through all five and wraps; the knob picks by zone', async () => {
    const { mapper, settle, track, mode, press, learn } = await autoSetup();
    learn(logic.automationTarget(track('Vocal'), 'next'), 31);
    learn(logic.automationTarget(track('Keys'), 'knob'), 32);
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await press(31);
      seen.push(mode('Vocal'));
    }
    expect(seen.slice(0, 5).sort()).toEqual([...logic.AUTOMATION_MODES].sort());
    expect(seen[5]).toBe(seen[0]);
    for (const [v, want] of [[0, 'off'], [40, 'read'], [64, 'write'], [90, 'touch'], [127, 'latch']]) {
      mapper.midi(CC(32, v), 'Roto-Control');
      await settle();
      expect(mode('Keys')).toBe(want);
    }
  });

  it('feedback lights the button of the current mode', async () => {
    const sent = [];
    const { engine, mapper, settle, track, learn } = await autoSetup({ send: (d, b) => (sent.push(b), true) });
    learn(logic.automationTarget(track('Bass'), 'read'), 33);
    mapper.update(mapper.rows()[0].mapping.id, { feedback: true });
    await settle();
    sent.length = 0;
    engine.setValue('/sessions/abc/tracks/Bass', 'automation_mode', 'latch'); // changed in LUNA
    await settle();
    expect(sent.at(-1)).toEqual([0xb0, 33, 0]);
    engine.setValue('/sessions/abc/tracks/Bass', 'automation_mode', 'read');
    await settle();
    expect(sent.at(-1)).toEqual([0xb0, 33, 127]);
  });

  it('in Channel Focus it acts on whichever track has the focus', async () => {
    const { engine, mapper, settle, track, mode, press } = await autoSetup();
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.automationTarget(track('Vocal'), 'write'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '34', device: 'Roto-Control', channel: 1 }));
    expect(mapper.focusMappings).toHaveLength(1);
    expect(mapper.rows()[0]).toMatchObject({ focus: true, where: 'Automation' });
    engine.setValue('/sessions/abc/contexts/main', 'last_selected_track', 'Keys');
    await settle();
    await press(34);
    expect(mode('Keys')).toBe('write');
    expect(mode('Vocal')).not.toBe('write');
  });
});

describe('Follow and Toggle for buttons', () => {
  it('a command fires on the press in Follow, and on every press of a latching button in Toggle', async () => {
    const { session, mapper, settle } = await connected({ tracks: ['Vocal', 'Bass', 'Keys', 'Drums'] });
    const focus = () => session.focusedTrack.value?.name.value;
    mapper.pick(logic.commandTarget('selectNextTrack'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '50' }));
    const id = mapper.rows()[0].mapping.id;
    const send = async (v) => {
      mapper.midi(CC(50, v), 'Roto-Control');
      await settle();
    };
    // Follow: a momentary button, 127 down then 0 up, moves once per press.
    await send(127);
    await send(0);
    expect(focus()).toBe('Bass');
    // A latching button sends 127 on one press and 0 on the next: Follow would miss every other.
    mapper.update(id, { mode: 'toggle' });
    await send(127);
    expect(focus()).toBe('Keys');
    await send(0);
    expect(focus()).toBe('Drums');
  });

  it('automation mode buttons honour Toggle too', async () => {
    const { engine, session, mapper, settle } = await connected();
    const bass = session.visibleTracks.find((t) => t.name.value === 'Bass');
    mapper.pick(logic.automationTarget(bass, 'next'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '51' }));
    mapper.update(mapper.rows()[0].mapping.id, { mode: 'toggle' });
    const before = engine.value(bass.path, 'automation_mode');
    mapper.midi(CC(51, 127), 'Ctl');
    await settle();
    const after1 = engine.value(bass.path, 'automation_mode');
    mapper.midi(CC(51, 0), 'Ctl');
    await settle();
    const after2 = engine.value(bass.path, 'automation_mode');
    expect(new Set([before, after1, after2]).size).toBe(3);
  });
});

describe('Channel Focus feedback workflow', () => {
  async function rig({ storage = logic.memoryStore() } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const sent = [];
    const mapper = new logic.Mapper(session, { storage, subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), send: (d, b) => (sent.push(b), true), feedbackHoldMs: 20 });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await new Promise((r) => setTimeout(r, 5));
    };
    const gain = (t) => `/sessions/abc/tracks/${t}/outputs/main/controls/gain`;
    return { engine, session, mapper, sent, settle, gain, storage };
  }

  it('select next/previous track moves a Roto knob mapped in Channel Focus to the new track\'s fader', async () => {
    const { engine, mapper, sent, settle, gain } = await rig();
    engine.setValue(gain('Vocal'), 'normalized_value', 0.25);
    engine.setValue(gain('Bass'), 'normalized_value', 0.5);
    engine.setValue(gain('Keys'), 'normalized_value', 1);
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader')));
    mapper.assign(logic.manualSource({ type: 'cc', number: '16', channel: 1, device: 'Roto-Control' }));
    expect(mapper.focusMappings[0].feedback).toBe(true); // on by default in Channel Focus
    mapper.pick(logic.commandTarget('selectNextTrack'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '123', channel: 1, device: 'Roto-Control' }));
    mapper.pick(logic.commandTarget('selectPreviousTrack'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '122', channel: 1, device: 'Roto-Control' }));
    await settle();
    const press = async (cc) => {
      sent.length = 0;
      mapper.midi(CC(cc, 127), 'Roto-Control');
      mapper.midi(CC(cc, 0), 'Roto-Control');
      await settle();
      await new Promise((r) => setTimeout(r, 40));
      return sent.filter((b) => b[1] === 16).map((b) => b[2]);
    };
    expect(await press(123)).toEqual([64]); // Bass at 0.5
    expect(await press(123)).toEqual([127]); // Keys at 1
    expect(await press(122)).toEqual([64]); // back to Bass
  });

  it('turns feedback on once for Channel Focus mappings saved without it, and the section switch sets them all', async () => {
    const storage = logic.memoryStore();
    storage.set(logic.KEYS.focus, [
      { id: 'a', source: { device: 'Roto-Control', type: 'cc', channel: 1, number: 16 }, target: { kind: 'focus', rest: 'outputs/main/controls/gain', area: 'Strip', name: 'gain', label: 'Fader' }, mode: 'absolute', min: 0, max: 1, invert: false, scope: 'focus' },
      { id: 'b', source: { device: 'Roto-Control', type: 'cc', channel: 1, number: 17 }, target: { kind: 'focus', rest: 'outputs/main/controls/pan', area: 'Strip', name: 'pan', label: 'Pan' }, mode: 'absolute', min: 0, max: 1, invert: false, scope: 'focus', feedback: false },
    ]);
    const { mapper } = await rig({ storage });
    expect(mapper.focusMappings.map((m) => m.feedback)).toEqual([true, false]); // an explicit off stays off
    expect(storage.get(logic.KEYS.focus).map((m) => m.feedback)).toEqual([true, false]);
    mapper.setFocusFeedback(true);
    expect(storage.get(logic.KEYS.focus).map((m) => m.feedback)).toEqual([true, true]);
    mapper.setFocusFeedback(false);
    expect(storage.get(logic.KEYS.focus).map((m) => m.feedback)).toEqual([false, false]);
  });
});

describe('latch learn', () => {
  it('keeps learning after each mapping until it is stopped', async () => {
    const { mapper } = await connected({ tracks: ['Vocal', 'Bass', 'Keys'] });
    mapper.setLearning(true, 'map', { latch: true });
    const fader = (name) => logic.targetOf(mapper.entries.find((e) => e.channel === name && e.label === 'Fader'));
    for (const [name, cc] of [['Vocal', 1], ['Bass', 2], ['Keys', 3]]) {
      mapper.pick(fader(name));
      mapper.midi(CC(cc, 64), 'Ctl');
      expect(mapper.learning).toBe(true);
      expect(mapper.pending).toEqual({ target: undefined, source: undefined });
    }
    expect(mapper.rows().map((r) => `${r.source} ${r.where}`)).toEqual(['CC 1 Vocal · Strip', 'CC 2 Bass · Strip', 'CC 3 Keys · Strip']);
    mapper.setLearning(false);
    expect(mapper.learning).toBe(false);
    expect(mapper.latch).toBe(false);
  });

  it('latches in Channel Focus too, and learning once still stops after one', async () => {
    const { mapper } = await connected();
    mapper.setLearning(true, 'focus', { latch: true });
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.label === 'Fader')));
    mapper.midi(CC(10, 1), 'Ctl');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.label === 'Pan')));
    mapper.midi(CC(11, 1), 'Ctl');
    expect(mapper.focusMappings).toHaveLength(2);
    expect(mapper.learnMode).toBe('focus');
    mapper.setLearning(true, 'map');
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(12, 127), 'Ctl');
    expect(mapper.learning).toBe(false);
  });
});

describe('Reset parameter to default', () => {
  it('resets the control last touched in LUNA, or last moved through the Proxy or Channel Focus', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }) });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
    };
    const ctl = (t, id) => `/sessions/abc/tracks/${t}/outputs/main/controls/${id}`;
    mapper.pick(logic.commandTarget('resetFocusedParameter'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '60' }));
    const press = async () => {
      mapper.midi(CC(60, 127), 'Ctl');
      mapper.midi(CC(60, 0), 'Ctl');
      await settle();
    };
    // Touched in LUNA, moved away from its default, then reset from the controller.
    engine.setValue(ctl('Bass', 'pan'), 'normalized_value', 0.1);
    engine.setValue(ctl('Bass', 'pan'), 'touch_count', 1);
    engine.setValue(ctl('Bass', 'pan'), 'touch_count', 0);
    await settle();
    await press();
    expect(engine.value(ctl('Bass', 'pan'), 'normalized_value')).toBe(0.5); // centre
    // Moved through a Channel Focus knob: that becomes the parameter in focus.
    engine.setValue('/sessions/abc/contexts/main', 'last_selected_track', 'Vocal');
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader')));
    mapper.assign(logic.manualSource({ type: 'cc', number: '16' }));
    mapper.midi(CC(16, 20), 'Ctl');
    await mapper.flush();
    await settle();
    expect(engine.value(ctl('Vocal', 'gain'), 'normalized_value')).not.toBe(engine.value(ctl('Bass', 'gain'), 'normalized_value'));
    const touchesBefore = engine.touches.length;
    await press();
    expect(engine.value(ctl('Vocal', 'gain'), 'normalized_value')).toBe(engine.value(ctl('Bass', 'gain'), 'normalized_value')); // 0 dB, like Bass
    expect(engine.touches.slice(touchesBefore)).toEqual([`${ctl('Vocal', 'gain')}:on`, `${ctl('Vocal', 'gain')}:off`]); // one undo step
    expect(mapper.lastReset).toMatchObject({ label: 'Fader', where: 'Vocal · Strip' });
  });
});

describe('Plugins mode', () => {
  async function pluginRig({ storage = logic.memoryStore(), uid = 'abc' } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession(uid, { name: 'Demo', tracks: ['Vocal', 'Bass', 'Keys'], packageUid: `pkg_${uid}` });
    engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
    engine.addPlugin('com.uaudio.uadx.la2a', { name: 'LA-2A', categories: ['Compressor'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const sent = [];
    const mapper = new logic.Mapper(session, {
      storage,
      subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
      pluginName: (id) => luna.plugins.byId(id)?.name.value,
      send: (d, b) => (sent.push(b), true),
      feedbackHoldMs: 20,
    });
    await mapper.start();
    const tracks = session.visibleTracks;
    const fx = {
      vocal1176: await tracks[0].insert('com.uaudio.uadx.1176'),
      bass1176: await tracks[1].insert('com.uaudio.uadx.1176'),
      keysLa2a: await tracks[2].insert('com.uaudio.uadx.la2a'),
    };
    await mapper.rescan();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await mapper.settled();
    };
    // A knob turned in a plugin window: LUNA reports its touch.
    const touch = async (path) => {
      engine.setValue(path, 'touch_count', 1);
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
    };
    const turn = async (cc, v) => {
      mapper.midi(CC(cc, v), 'Roto-Control');
      await mapper.flush();
      await settle();
    };
    return { engine, session, mapper, fx, sent, settle, touch, turn, storage };
  }

  it('learns a map from one instance and drives whichever instance of that plugin is focused', async () => {
    const { engine, mapper, fx, settle, touch, turn } = await pluginRig();
    mapper.setLearning(true, 'plugin');
    await touch(`${fx.vocal1176.path}/controls/input`);
    mapper.midi(CC(21, 0), 'Roto-Control');
    await settle();
    expect(mapper.pluginMappings).toHaveLength(1);
    expect(mapper.pluginMappings[0]).toMatchObject({ scope: 'plugin', feedback: true, target: { kind: 'plugin', pluginId: 'com.uaudio.uadx.1176', param: 'input' } });
    expect(mapper.focusPlugin()?.path).toBe(fx.vocal1176.path);
    await turn(21, 127);
    expect(engine.value(`${fx.vocal1176.path}/controls/input`, 'normalized_value')).toBe(1);
    // Turning a knob in the other 1176's window focuses that instance: same map, other plugin.
    await touch(`${fx.bass1176.path}/controls/bypass`);
    expect(mapper.focusPlugin()?.path).toBe(fx.bass1176.path);
    await turn(21, 0);
    expect(engine.value(`${fx.bass1176.path}/controls/input`, 'normalized_value')).toBe(0);
    expect(engine.value(`${fx.vocal1176.path}/controls/input`, 'normalized_value')).toBe(1);
  });

  it('is a layer: its knobs win while its plugin is focused, and fall through otherwise', async () => {
    const { engine, session, mapper, fx, settle, touch, turn } = await pluginRig();
    // A regular mapping on CC 21: the Keys fader.
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Keys' && e.label === 'Fader')));
    mapper.assign(logic.manualSource({ type: 'cc', number: '21', device: 'Roto-Control', channel: 1 }));
    // The same CC in the 1176's map.
    mapper.setLearning(true, 'plugin');
    await touch(`${fx.vocal1176.path}/controls/input`);
    mapper.midi(CC(21, 64), 'Roto-Control');
    await settle();
    expect(mapper.sessionMappings).toHaveLength(1); // not taken away from the regular mapping
    const keysGain = session.visibleTracks[2].gain;
    const before = engine.value(keysGain.path, 'normalized_value');
    await turn(21, 0);
    expect(engine.value(`${fx.vocal1176.path}/controls/input`, 'normalized_value')).toBe(0);
    expect(engine.value(keysGain.path, 'normalized_value')).toBe(before); // the 1176 owned the knob
    // An LA-2A has no map: CC 21 falls through to the regular mapping.
    await touch(`${fx.keysLa2a.path}/controls/input`);
    await turn(21, 127);
    expect(engine.value(keysGain.path, 'normalized_value')).toBe(1);
    expect(engine.value(`${fx.keysLa2a.path}/controls/input`, 'normalized_value')).not.toBe(1);
  });

  it('sends the focused instance\'s values to motorized knobs, and holds back the layer below', async () => {
    const { engine, mapper, fx, sent, settle, touch } = await pluginRig();
    mapper.setLearning(true, 'plugin');
    await touch(`${fx.vocal1176.path}/controls/input`);
    mapper.midi(CC(21, 0), 'Roto-Control');
    await settle();
    engine.setValue(`${fx.vocal1176.path}/controls/input`, 'normalized_value', 0.25);
    engine.setValue(`${fx.bass1176.path}/controls/input`, 'normalized_value', 1);
    await settle();
    sent.length = 0;
    await touch(`${fx.bass1176.path}/controls/bypass`);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent.filter((b) => b[1] === 21).at(-1)).toEqual([0xb0, 21, 127]);
    sent.length = 0;
    await touch(`${fx.vocal1176.path}/controls/bypass`);
    await new Promise((r) => setTimeout(r, 40));
    expect(sent.filter((b) => b[1] === 21).at(-1)).toEqual([0xb0, 21, 32]);
  });

  it('keeps maps across sessions, can lock an instance, and deletes a whole map', async () => {
    const storage = logic.memoryStore();
    const a = await pluginRig({ storage });
    a.mapper.setLearning(true, 'plugin');
    await a.touch(`${a.fx.vocal1176.path}/controls/input`);
    a.mapper.midi(CC(21, 0), 'Roto-Control');
    await a.settle();
    const b = await pluginRig({ storage, uid: 'other' });
    expect(b.mapper.pluginMaps()).toEqual([{ pluginId: 'com.uaudio.uadx.1176', pluginName: 'UA 1176', count: 1 }]);
    b.mapper.setPluginLock(b.fx.bass1176.path);
    await b.touch(`${b.fx.vocal1176.path}/controls/bypass`); // touching another doesn't move a lock
    expect(b.mapper.focusPlugin()?.path).toBe(b.fx.bass1176.path);
    await b.turn(21, 127);
    expect(b.engine.value(`${b.fx.bass1176.path}/controls/input`, 'normalized_value')).toBe(1);
    b.mapper.deletePluginMap('com.uaudio.uadx.1176');
    expect(b.mapper.pluginMappings).toEqual([]);
  });
});

describe('templates hold every mode', () => {
  it('saves and restores mappings, globals, Channel Focus, the Proxy and plugin maps', async () => {
    const { mapper } = await connected();
    mapper.pick(logic.commandTarget('play'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '1' }));
    mapper.pick(logic.commandTarget('stop'));
    mapper.assign(logic.manualSource({ type: 'cc', number: '2' }));
    mapper.update(mapper.sessionMappings[1].id, { scope: 'global' });
    mapper.setLearning(true, 'focus');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.label === 'Pan')));
    mapper.assign(logic.manualSource({ type: 'cc', number: '3' }));
    mapper.setLearning(true, 'mighty');
    mapper.assign(logic.manualSource({ type: 'cc', number: '4' }));
    mapper.pluginMappings.push({ id: 'p1', source: { device: null, type: 'cc', channel: null, number: 5 }, target: { kind: 'plugin', pluginId: 'x', pluginName: 'X', param: 'input', label: 'Input' }, mode: 'absolute', min: 0, max: 1, invert: false, scope: 'plugin' });
    mapper.saveTemplate('Roto layout');
    const t = mapper.templates()[0];
    expect([t.mappings.length, t.globals.length, t.focus.length, !!t.mighty, t.plugins.length]).toEqual([1, 1, 1, true, 1]);
    // Wipe everything, then load the template back.
    mapper.sessionMappings = [];
    mapper.globalMappings = [];
    mapper.focusMappings = [];
    mapper.mighty = null;
    mapper.pluginMappings = [];
    mapper.applyTemplate('Roto layout');
    expect([mapper.sessionMappings.length, mapper.globalMappings.length, mapper.focusMappings.length, !!mapper.mighty, mapper.pluginMappings.length]).toEqual([1, 1, 1, true, 1]);
    expect(mapper.mighty.source.number).toBe(4);
  });
});

describe('plugins loaded after MIDI Learn started', () => {
  it('learns a plugin map and a Channel Focus plugin parameter from a plugin inserted later, without a rescan', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    engine.addPlugin('com.uaudio.610', { name: '610-B', categories: ['EQ'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const notes = [];
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), pluginName: (id) => luna.plugins.byId(id)?.name.value });
    mapper.onLearnNote = (t) => notes.push(t);
    await mapper.start();
    // The 610 goes in after MIDI Learn has scanned the session.
    const vocal610 = await session.visibleTracks[0].insert('com.uaudio.610');
    const bass610 = await session.visibleTracks[1].insert('com.uaudio.610');
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await mapper.settled();
    };
    await settle();
    const touch = async (path) => {
      engine.setValue(path, 'touch_count', 1);
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
    };
    expect(mapper.liveInserts().map((i) => i.pluginName)).toEqual(['610-B', '610-B']);
    mapper.setLearning(true, 'plugin');
    await touch(`${vocal610.path}/controls/input`);
    mapper.midi(CC(21, 0), 'Roto-Control');
    expect(mapper.pluginMappings).toHaveLength(1);
    expect(notes.at(-1)).toMatch(/picked/);
    // The map drives the other 610 once it's touched.
    await touch(`${bass610.path}/controls/bypass`);
    mapper.midi(CC(21, 127), 'Roto-Control');
    await mapper.flush();
    await settle();
    expect(engine.value(`${bass610.path}/controls/input`, 'normalized_value')).toBe(1);
    // Channel Focus learns the same kind of parameter.
    mapper.setLearning(true, 'focus');
    await touch(`${vocal610.path}/controls/input`);
    mapper.midi(CC(22, 0), 'Roto-Control');
    expect(mapper.focusMappings.map((m) => m.target.area)).toEqual(['Insert 1 · 610-B']);
  });
});

describe('Hold (learn one after another)', () => {
  it('can be switched on mid-learn, and the last of several clicked parameters is the one mapped', async () => {
    const { engine, session, mapper, settle } = await connected({ tracks: ['Vocal', 'Bass', 'Keys'] });
    const gain = (n) => session.visibleTracks.find((t) => t.name.value === n).gain.path;
    const click = async (path) => {
      engine.setValue(path, 'touch_count', 1);
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
    };
    mapper.setLearning(true, 'map');
    mapper.setHold(true);
    // Several clicks in LUNA before any knob: still learning, the latest click wins.
    await click(gain('Vocal'));
    await click(gain('Bass'));
    expect(mapper.learning).toBe(true);
    expect(mapper.rows()).toHaveLength(0);
    mapper.midi(CC(1, 10), 'Roto-Control');
    expect(mapper.rows().map((r) => r.where)).toEqual(['Bass · Strip']);
    // Hold keeps it going for the next one.
    expect(mapper.learning).toBe(true);
    await click(gain('Keys'));
    mapper.midi(CC(2, 10), 'Roto-Control');
    expect(mapper.rows().map((r) => r.where)).toEqual(['Bass · Strip', 'Keys · Strip']);
    mapper.setHold(false);
    await click(gain('Vocal'));
    mapper.midi(CC(3, 10), 'Roto-Control');
    expect(mapper.learning).toBe(false); // Hold off: this one ends it
  });

  it('a motorized knob echoing a value MIDI Learn just sent does not complete a learn', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), send: () => true, feedbackHoldMs: 20 });
    await mapper.start();
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Vocal' && e.label === 'Fader')));
    mapper.assign(logic.manualSource({ type: 'cc', number: '16', device: 'Roto-Control', channel: 1 }));
    mapper.update(mapper.rows()[0].mapping.id, { feedback: true }); // sends the fader's value back
    const sent = mapper.fb.sent.get(mapper.rows()[0].mapping.id).raw;
    mapper.setLearning(true, 'map');
    mapper.pick(logic.targetOf(mapper.entries.find((e) => e.channel === 'Bass' && e.label === 'Pan')));
    mapper.midi(CC(16, sent), 'Roto-Control'); // the motor's echo
    expect(mapper.learning).toBe(true);
    mapper.midi(CC(17, 30), 'Roto-Control'); // the user's hand
    expect(mapper.rows().map((r) => `${r.source} ${r.where}`)).toContain('CC 17 Bass · Strip');
  });
});

describe('Plugins follow the selected track', () => {
  it('moves a plugin map to the selected track\'s instance; a touched plugin counts until the selection moves', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['T1', 'T2', 'T3'], packageUid: 'pkg_abc' });
    engine.addPlugin('com.uaudio.610', { name: '610-A', categories: ['EQ'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), pluginName: (id) => luna.plugins.byId(id)?.name.value });
    await mapper.start();
    const fx = [];
    for (const t of session.visibleTracks) fx.push(await t.insert('com.uaudio.610'));
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await mapper.settled();
    };
    await settle();
    const touch = async (path) => {
      engine.setValue(path, 'touch_count', 1);
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
    };
    const select = async (id) => {
      engine.setValue('/sessions/abc/contexts/main', 'last_selected_track', id);
      await settle();
    };
    const turn = async (v) => {
      mapper.midi(CC(24, v), 'Roto-Control');
      await mapper.flush();
      await settle();
    };
    const level = (i) => engine.value(`${fx[i].path}/controls/input`, 'normalized_value');
    // Learn on T1's 610.
    await select('T1');
    mapper.setLearning(true, 'plugin');
    await touch(`${fx[0].path}/controls/input`);
    mapper.midi(CC(24, 0), 'Roto-Control');
    await settle();
    // Select T2: the map follows the selection to T2's 610.
    await select('T2');
    expect(mapper.focusPlugin()?.path).toBe(fx[1].path);
    await turn(127);
    expect(level(1)).toBe(1);
    // Touch a knob in T3's 610 window: that instance takes over until the selection moves.
    await touch(`${fx[2].path}/controls/bypass`);
    await turn(0);
    expect(level(2)).toBe(0);
    await select('T1');
    expect(mapper.focusPlugin()?.path).toBe(fx[0].path);
    await turn(127);
    expect(level(0)).toBe(1);
    // Channel Focus locked elsewhere doesn't hold the plugin focus back.
    mapper.setFocusLock('T3');
    await select('T2');
    expect(mapper.focusPlugin()?.path).toBe(fx[1].path);
  });
});

describe('Hold with real knob turns', () => {
  it('maps eight parameters to eight knobs in order, though each turn is a stream of messages', async () => {
    let clock = 0;
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), now: () => clock });
    await mapper.start();
    const faders = session.visibleTracks.map((t) => logic.targetOf(mapper.entries.find((e) => e.channelId === t.id && e.label === 'Fader')));
    mapper.setLearning(true, 'focus');
    mapper.setHold(true);
    faders.forEach((fader, i) => {
      clock += 1500; // the user reaches for the next parameter
      mapper.pick(fader); // touch it in LUNA
      clock += 1200;
      // Turn knob i: a stream of messages over about half a second, still going after the
      // first one completed the mapping.
      for (let k = 0; k < 10; k++) {
        mapper.midi(CC(24 + i, 40 + k * 3), 'Roto-Control');
        clock += 50;
      }
    });
    expect(mapper.focusMappings.map((m) => `${m.source.number}→${m.target.rest.split('/')[0]}`)).toHaveLength(8);
    // Each knob maps to the parameter touched just before it: CC 24 → first, …, CC 31 → eighth.
    const byKnob = mapper.focusMappings.map((m) => m.source.number);
    expect(byKnob).toEqual([24, 25, 26, 27, 28, 29, 30, 31]);
    expect(mapper.learning).toBe(true);
  });

  it('a knob turned again after a pause can start the next mapping', async () => {
    let clock = 0;
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['A', 'B'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), now: () => clock });
    await mapper.start();
    const [a, b] = session.visibleTracks.map((t) => logic.targetOf(mapper.entries.find((e) => e.channelId === t.id && e.label === 'Fader')));
    mapper.setLearning(true, 'map', { latch: true });
    mapper.pick(a);
    mapper.midi(CC(24, 10), 'Ctl');
    clock += 100;
    mapper.midi(CC(24, 12), 'Ctl'); // the same turn: ignored
    expect(mapper.pending.source).toBeUndefined();
    clock += 1000; // a pause
    mapper.midi(CC(24, 30), 'Ctl'); // a fresh turn of the same knob
    expect(mapper.pending.source).toMatchObject({ number: 24 });
    mapper.pick(b);
    expect(mapper.rows().map((r) => r.where)).toEqual(['B · Strip']); // moved to B, as asked
  });
});

describe('Hold in Plugins mode', () => {
  it('adds eight parameters of one plugin to its map in order, through trailing touches and knob streams', async () => {
    let clock = 0;
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['T1'], packageUid: 'pkg_abc' });
    engine.addPlugin('com.uaudio.api', { name: 'API Vision', categories: ['Channel Strip'] });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    await luna.plugins.load();
    const mapper = new logic.Mapper(session, { storage: logic.memoryStore(), subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }), pluginName: (id) => luna.plugins.byId(id)?.name.value, now: () => clock });
    await mapper.start();
    const fx = await session.visibleTracks[0].insert('com.uaudio.api');
    // Eight EQ parameters on the strip (the mock plugin only has two of its own).
    const bands = ['31Hz', '63Hz', '125Hz', '250Hz', '500Hz', '1kHz', '2kHz', '4kHz'];
    for (const b of bands) engine.addControl(`${fx.path}/controls/eq_${b}`, 'parameter', { discrete: false, value: 0.5, real: 0, str: '0', automatable: true, normalized: 0.5 });
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
      await Promise.all([...mapper.loading.values()]);
      await mapper.settled();
    };
    await settle();
    mapper.setLearning(true, 'plugin');
    mapper.setHold(true);
    for (let i = 0; i < bands.length; i++) {
      const path = `${fx.path}/controls/eq_${bands[i]}`;
      clock += 1500;
      engine.setValue(path, 'touch_count', 1); // the user clicks the band in the plugin window
      await settle();
      engine.setValue(path, 'touch_count', 0);
      await settle();
      clock += 400;
      for (let k = 0; k < 8; k++) {
        mapper.midi(CC(24 + i, 50 + k), 'Roto-Control'); // the knob turn, a stream of messages
        clock += 40;
        if (k === 1) {
          // The editor reports one more touch of that band while the knob is still turning.
          engine.setValue(path, 'touch_count', 1);
          await settle();
          engine.setValue(path, 'touch_count', 0);
          await settle();
        }
      }
    }
    const map = mapper.pluginMappings.map((m) => `${m.source.number}:${m.target.param}`);
    expect(map).toEqual(bands.map((b, i) => `${24 + i}:eq_${b}`));
    expect(mapper.learning).toBe(true);
  });
});

describe('saved with the session', () => {
  async function open({ engine = new Luna.MockEngine(), storage = logic.memoryStore(), uid = 'abc' } = {}) {
    if (!engine.sessionAdded) {
      engine.addSession(uid, { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: `pkg_${uid}` });
      engine.sessionAdded = true;
    }
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const sessionStore = new logic.SessionSettings(session);
    await sessionStore.load();
    const mapper = new logic.Mapper(session, { storage, sessionStore, subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }) });
    await mapper.start();
    return { engine, luna, session, sessionStore, mapper, storage };
  }
  const learnFader = async (r, cc) => {
    const gain = gainOf(r.session, 'Bass');
    r.mapper.setLearning(true);
    r.engine.setValue(gain.path, 'touch_count', 1);
    await r.mapper.settled();
    await r.engine.settled();
    r.mapper.midi(CC(cc, 64), 'dev');
  };

  it('keeps session mappings in the session, not in the machine\'s storage', async () => {
    const r = await open();
    await learnFader(r, 7);
    await r.mapper.flushSession();
    expect(r.sessionStore.available).toBe(true);
    expect(r.storage.get(logic.KEYS.session('pkg_abc'))).toBeUndefined();
    // a fresh page on the same session reads them back from LUNA
    const again = await open({ engine: r.engine });
    expect(again.mapper.sessionMappings).toHaveLength(1);
    expect(again.mapper.sessionMappings[0].source).toMatchObject({ type: 'cc', number: 7 });
  });

  it('adopts mappings an earlier version kept in local storage, once', async () => {
    const storage = logic.memoryStore();
    storage.set(logic.KEYS.session('pkg_abc'), [{ id: 'old', scope: 'session', mode: 'follow', source: { type: 'cc', number: 9, channel: null, device: null }, target: { kind: 'command', command: 'play', label: 'Play' } }]);
    const r = await open({ storage });
    expect(r.mapper.sessionMappings.map((m) => m.id)).toEqual(['old']);
    await r.mapper.flushSession();
    expect(r.sessionStore.get('session')).toHaveLength(1);
    // the session's copy now wins over the machine's
    storage.set(logic.KEYS.session('pkg_abc'), []);
    const again = await open({ engine: r.engine, storage });
    expect(again.mapper.sessionMappings.map((m) => m.id)).toEqual(['old']);
  });

  it('writes nothing into a session that has no mappings', async () => {
    const r = await open();
    await r.mapper.flushSession();
    expect(r.sessionStore.has('session')).toBe(false);
  });

  it('saves Channel Focus with the session only when asked, and goes back to the shared layout', async () => {
    const r = await open();
    const focus = [{ id: 'f1', scope: 'focus', mode: 'follow', source: { type: 'cc', number: 20, channel: null, device: null }, target: { kind: 'focus', area: 'Strip', label: 'Fader', control: 'gain' } }];
    r.mapper.focusMappings = focus;
    r.mapper.save();
    expect(r.mapper.savedWithSession('focus')).toBe(false);
    expect(r.storage.get(logic.KEYS.focus)).toHaveLength(1);

    r.mapper.setSavedWithSession('focus', true);
    await r.mapper.flushSession();
    expect(r.mapper.savedWithSession('focus')).toBe(true);
    r.mapper.focusMappings = [];
    r.mapper.save(); // goes to the session, so the shared layout keeps its mapping
    await r.mapper.flushSession();
    expect(r.storage.get(logic.KEYS.focus)).toHaveLength(1);
    const again = await open({ engine: r.engine, storage: r.storage });
    expect(again.mapper.focusMappings).toEqual([]);

    again.mapper.setSavedWithSession('focus', false);
    await again.mapper.flushSession();
    expect(again.mapper.savedWithSession('focus')).toBe(false);
    const third = await open({ engine: r.engine, storage: r.storage });
    expect(third.mapper.focusMappings).toHaveLength(1);
  });

  it('falls back to local storage on a LUNA without session storage', async () => {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const sessionStore = new logic.SessionSettings(session);
    sessionStore.ctx.load = () => Promise.reject(new Error('no storage'));
    sessionStore.openLegacy = () => ({ load: () => Promise.reject(new Error('no preferences')) }); // and no older node either
    expect(await sessionStore.load()).toBe(false);
    const storage = logic.memoryStore();
    const mapper = new logic.Mapper(session, { storage, sessionStore });
    mapper.sessionMappings = [{ id: 'x' }];
    mapper.loadStored();
    mapper.sessionMappings = [{ id: 'x' }];
    mapper.save();
    expect(storage.get(logic.KEYS.session('pkg_abc'))).toEqual([{ id: 'x' }]);
    expect(mapper.setSavedWithSession('focus', true)).toBe(false);
  });

  // A fake of the older LUNA's /preferences node: same surface as LegacyPreferences.
  const fakeLegacy = (data = {}) => ({
    data,
    load: async () => {},
    value: (rec, field) => ({ value: data[`${rec}/${field}`] }),
    add: async (rec, field, v) => { data[`${rec}/${field}`] = v; },
    set: async (rec, field, v) => { data[`${rec}/${field}`] = v; },
    remove: async (rec, field) => { delete data[`${rec}/${field}`]; },
  });
  async function oldLuna(legacy, { storageWorks = false } = {}) {
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const store = new logic.SessionSettings(session);
    if (!storageWorks) store.ctx.load = () => Promise.reject(new Error('no storage'));
    store.openLegacy = () => legacy;
    return store;
  }

  it('keeps its settings in the older preferences node on a LUNA that has no session storage', async () => {
    const legacy = fakeLegacy({ 'settings/focus': { v: [{ id: 'f' }] } });
    const store = await oldLuna(legacy);
    expect(await store.load()).toBe(true);
    expect(store.legacy).toBe(true);
    expect(store.get('focus')).toEqual([{ id: 'f' }]); // what that LUNA saved earlier is still read
    store.set('plugins', [{ id: 'p' }]);
    store.remove('focus');
    await store.flush();
    expect(legacy.data).toEqual({ 'settings/plugins': { v: [{ id: 'p' }] } });
  });

  it('moves to the older node when /storage reads fine but rejects writes', async () => {
    const legacy = fakeLegacy();
    const store = await oldLuna(legacy, { storageWorks: true });
    expect(await store.load()).toBe(true);
    expect(store.legacy).toBe(false);
    store.ctx.add = () => Promise.reject(new Error('uasrv.unknown_command'));
    store.set('mighty', { m: 1 });
    await store.flush();
    expect(store.legacy).toBe(true);
    expect(legacy.data['settings/mighty']).toEqual({ v: { m: 1 } });
    expect(store.get('mighty')).toEqual({ m: 1 });
  });

  it('adopts settings an older LUNA saved when /storage has none, and saves them there', async () => {
    const legacy = fakeLegacy({ 'settings/focus': { v: [{ id: 'f' }] } });
    const store = await oldLuna(legacy, { storageWorks: true });
    await store.load();
    await store.flush();
    expect(store.legacy).toBe(false);
    expect(store.get('focus')).toEqual([{ id: 'f' }]);
    expect(store.ctx.value('settings', 'focus').value).toEqual({ v: [{ id: 'f' }] });
    expect(legacy.data['settings/focus']).toBeDefined(); // the old copy is left alone
  });
});

describe('device names', () => {
  it('treats the same hardware as one device whoever names it', () => {
    expect(logic.sameDevice('Roto-Control (2)', 'Roto-Control')).toBe(true);
    expect(logic.sameDevice('IAC IAC Bus 1', 'IAC Bus 1')).toBe(true);
    expect(logic.sameDevice('nanoKONTROL2', 'NANOKONTROL2')).toBe(true);
    expect(logic.sameDevice('Roto-Control', 'Roto-Control Mini')).toBe(false);
    expect(logic.sameDevice('IAC Bus 1', 'IAC Bus 5')).toBe(false);
    expect(logic.sameDevice('a', undefined)).toBe(false);
  });
});

describe('pan on mono and stereo channels', () => {
  const fake = (path, n) => {
    const subs = [];
    return { path, normalized: { value: n, onChange: (f) => (subs.push(f), () => subs.splice(subs.indexOf(f), 1)), set: async (v) => { fake.last[path] = v; } }, begin() {}, end() {}, resetToDefault: async () => {}, load: async () => {} };
  };
  fake.last = {};

  it('names the pan a channel really has', () => {
    expect(logic.panFor('pan', false)).toBe('pan');
    expect(logic.panFor('pan_left', false)).toBe('pan');
    expect(logic.panFor('balance', false)).toBe('pan');
    expect(logic.panFor('pan', true)).toBe('balance');
    expect(logic.panFor('pan_left', true)).toBe('pan_left');
    expect(logic.panFor('gain', true)).toBe('gain');
  });

  it('Balance moves the left and right pans together, and reads back from them', async () => {
    const left = fake('/o/controls/pan_left', 0);
    const right = fake('/o/controls/pan_right', 1);
    const b = new logic.BalanceControl(left, right);
    expect(b.path).toBe('/o/controls/balance');
    expect(b.normalized.value).toBe(0.5);
    expect(b.display.value).toBe('C');
    await b.normalized.set(1);
    expect(fake.last['/o/controls/pan_left']).toBe(1);
    expect(fake.last['/o/controls/pan_right']).toBe(1);
    await b.normalized.set(0.75);
    expect([fake.last['/o/controls/pan_left'], fake.last['/o/controls/pan_right']]).toEqual([0.5, 1]);
    await b.normalized.set(0);
    expect([fake.last['/o/controls/pan_left'], fake.last['/o/controls/pan_right']]).toEqual([0, 0]);
    left.normalized.value = 0.5;
    right.normalized.value = 1;
    expect(b.normalized.value).toBe(0.75);
    expect(b.display.value).toBe('50R');
  });

  it('a pan mapped on a mono channel finds the stereo channel\'s pan, and back', () => {
    const e = (name) => ({ path: `/t/outputs/main/controls/${name}`, channel: 'T', area: 'Strip', name });
    const stereo = [e('gain'), e('pan_left'), e('pan_right'), e('balance')];
    const mono = [e('gain'), e('pan')];
    const target = (name) => ({ kind: 'control', path: '/other', channel: 'T', area: 'Strip', name });
    expect(logic.resolve(stereo, target('pan')).name).toBe('balance');
    expect(logic.resolve(stereo, target('pan_right')).name).toBe('pan_right');
    expect(logic.resolve(mono, target('pan_left')).name).toBe('pan');
    expect(logic.resolve(mono, target('balance')).name).toBe('pan');
  });
});

describe('Shift modifier', () => {
  async function shiftSetup() {
    let clock = 1000;
    const storage = logic.memoryStore();
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'Demo', tracks: ['Vocal', 'Bass'], packageUid: 'pkg_abc' });
    await engine.settled();
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    const mapper = new logic.Mapper(session, { storage, now: () => clock });
    await mapper.start();
    const settle = async () => {
      await mapper.settled();
      await engine.settled();
      await luna.settled();
    };
    const tick = (ms = 300) => { clock += ms; };
    return { engine, luna, session, mapper, storage, settle, tick };
  }

  it('Hold mode lets one button run two different functions (Normal vs Shift) and falls through for unshifted controls', async () => {
    const { engine, mapper, settle, tick } = await shiftSetup();
    // Learn CC 64 as Shift (defaults to Hold mode)
    mapper.setLearning(true, 'shift');
    mapper.midi(CC(64, 127), 'MPK');
    expect(mapper.learning).toBe(false);
    expect(mapper.shift).toMatchObject({ mode: 'hold', source: { type: 'cc', number: 64, device: 'MPK' } });

    // Map CC 76 Normal -> Play, CC 77 Normal -> Stop, Shift + CC 76 -> Loop
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(76, 127), 'MPK');
    mapper.pick(logic.commandTarget('stop'));
    mapper.midi(CC(77, 127), 'MPK');
    // Hold Shift while learning: Shift button is not captured, and the new mapping gets shift: true
    mapper.pick(logic.commandTarget('toggleLoop'));
    mapper.midi(CC(64, 127), 'MPK');
    expect(mapper.shiftActive).toBe(true);
    expect(mapper.learning).toBe(true);
    mapper.midi(CC(76, 127), 'MPK');
    expect(mapper.learning).toBe(false);
    mapper.midi(CC(64, 0), 'MPK');
    expect(mapper.shiftActive).toBe(false);
    expect(mapper.rows().map((r) => [r.target, r.shift])).toEqual([['Play', false], ['Stop', false], ['Loop on / off', true]]);

    // Normal press of CC 76 -> Play (not Loop)
    tick();
    mapper.midi(CC(76, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
    expect(engine.value('/sessions/abc', 'looping')).toBe(false);

    // Hold Shift + press CC 76 -> Loop (not Play)
    tick();
    mapper.midi(CC(64, 127), 'MPK');
    mapper.midi(CC(76, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'looping')).toBe(true);

    // Unshifted CC 77 (Stop) still falls through while Shift is held
    tick();
    mapper.midi(CC(77, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(false);

    // Release Shift -> CC 76 runs Play again
    mapper.midi(CC(64, 0), 'MPK');
    tick();
    mapper.midi(CC(76, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('Toggle mode latches Shift on and off, including for one-shot CC buttons without 0 release', async () => {
    const { engine, mapper, settle, tick } = await shiftSetup();
    mapper.setShift({ device: 'MPK', type: 'cc', channel: 1, number: 64 }, 'toggle');
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(76, 127), 'MPK');
    mapper.setShiftActive(true);
    mapper.pick(logic.commandTarget('toggleLoop'));
    mapper.midi(CC(76, 127), 'MPK');
    mapper.setShiftActive(false);

    // Press Shift once (one-shot CC 127) -> Shift latches ON
    tick();
    mapper.midi(CC(64, 127), 'MPK');
    expect(mapper.shiftActive).toBe(true);
    tick();
    mapper.midi(CC(76, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'looping')).toBe(true);
    expect(engine.value('/sessions/abc', 'playing')).toBe(false);

    // Press Shift again after quiet gap -> Shift latches OFF
    tick();
    mapper.midi(CC(64, 127), 'MPK');
    expect(mapper.shiftActive).toBe(false);
    tick();
    mapper.midi(CC(76, 127), 'MPK');
    await settle();
    expect(engine.value('/sessions/abc', 'playing')).toBe(true);
  });

  it('persists Shift settings across reload, templates, and export/import', async () => {
    const { session, mapper, storage } = await shiftSetup();
    mapper.setShift({ device: 'MPK', type: 'note', channel: 1, number: 60 }, 'toggle');
    mapper.pick(logic.commandTarget('play'));
    mapper.midi(CC(76, 127), 'MPK');
    mapper.setShiftActive(true);
    mapper.pick(logic.commandTarget('stop'));
    mapper.midi(CC(76, 127), 'MPK');
    mapper.saveTemplate('MPK Shift');

    // Reload from storage
    const reloaded = new logic.Mapper(session, { storage });
    await reloaded.start();
    expect(reloaded.shift).toEqual({ mode: 'toggle', source: { device: 'MPK', type: 'note', channel: 1, number: 60 } });
    expect(reloaded.rows().map((r) => [r.target, r.shift])).toEqual([['Play', false], ['Stop', true]]);

    // Export / import into a fresh mapper
    const doc = JSON.parse(JSON.stringify(mapper.exportAll()));
    const fresh = new logic.Mapper(session, { storage: logic.memoryStore() });
    await fresh.start();
    fresh.importAll(doc);
    expect(fresh.shift).toMatchObject({ mode: 'toggle', source: { type: 'note', number: 60 } });
    fresh.clearShift();
    expect(fresh.shift).toBeNull();
    fresh.applyTemplate('MPK Shift');
    expect(fresh.shift).toMatchObject({ mode: 'toggle', source: { type: 'note', number: 60 } });
    expect(fresh.rows().map((r) => [r.target, r.shift])).toEqual([['Play', false], ['Stop', true]]);
  });
});
