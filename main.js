// MIDI Learn: DOM wiring. Connects to LUNA, follows the focused session, listens to MIDI
// (LUNA's own MIDI input and output, through the SDK), and renders
// what logic.js's Mapper holds. Every listener is released when the session changes.

const $ = (id) => document.getElementById(id);
// Settings live in the webview's localStorage.
// A ?demo page runs on an in-page mock session. It must never touch the user's real setup, so
// it never sends MIDI out (feedback).
const DEMO = new URLSearchParams(location.search).has('demo');
/** Which build of the page is running, so a stale page is obvious. */
const BUILD = '2026-10-26.1';
const local = AddOnLogic.localStore();
const store = {
  get: (key) => local.get(key),
  set: (key, value) => local.set(key, value),
};
const PREFS = 'midilearn.prefs';
const prefs = { device: '', filter: 'all', fold: {}, ...(store.get(PREFS) ?? {}) };
const savePrefs = () => store.set(PREFS, prefs);

let luna;
let session;
let mapper;
let sessionGen = 0;
let releases = [];
const keep = (u) => releases.push(u);
const rows = new Luna.Bindings(); // live values in the mapping list and the parameter list
const openRows = new Set();
let picked; // path or command id highlighted in the parameter list

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const X = '<svg viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
// Feedback on: a double arrow drawn at the UI's 1.8 line weight, centred in its tag
const FB_ICON = '<svg viewBox="0 0 16 12" width="16" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6h12M5 2.8L1.8 6 5 9.2M11 2.8L14.2 6 11 9.2"/></svg>';
const CHEVRON = '<svg viewBox="0 0 14 14"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// For `ua-builder probe` and the console: the live objects, read-only.
globalThis.midiLearn = {
  get luna() {
    return luna;
  },
  get mapper() {
    return mapper;
  },
  get midi() {
    return midiIn;
  },
};

let toastTimer;
function toast(text, error = false) {
  const el = $('message');
  el.textContent = text;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 5000 : 2600);
}

// ---- MIDI in and out ----------------------------------------------------------------------
// Where MIDI comes from, best first. Only one source is live at a time, or every message would
// arrive twice:
//   luna    LUNA publishes MIDI ports (Luna.MidiInput / Luna.SendMidi): every message, in order, and
//           feedback out of the device. A LUNA release that has them is the way forward.
//   webmidi the browser's Web MIDI (Chrome, Edge, LUNA on Windows). LUNA's macOS webview has none.
//   last    LUNA's per-device "last controller / last note" values, which every LUNA publishes. They
//           are coalesced and a repeat of the same value is not a change, so a knob works but a
//           repeated identical message can be missed. Input only: no feedback.
const midiIn = { via: 'none', inputs: [], lastHit: 0, access: undefined, ready: false, stops: [], listeningTo: '', lastStops: [] };

/** A message from `source` counts only while that source is the live one. */
const from = (source) => (data, device) => {
  if (midiIn.via === source) onMidi(data, device);
};

/** Devices LUNA publishes an input port for (a LUNA with MIDI ports), and every real device. */
const portDevices = () => luna.midiDevices.items.filter((d) => d.isPhysical && d.inputPort && d.name.value);
const realDevices = () => luna.midiDevices.items.filter((d) => d.isPhysical && d.name.value);

/** The device with this name and an output port, for MIDI out through LUNA. */
function outputDevice(name) {
  const outs = luna.midiDevices.items.filter((d) => d.isPhysical && d.outputPort && d.name.value);
  return outs.find((d) => d.name.value === name) ?? outs.find((d) => d.name.value.startsWith(name)) ?? outs.find((d) => d.name.value.includes(name));
}

/**
 * MIDI out, for feedback to motorized controllers: out of the device LUNA lists with the input's
 * name (when LUNA has MIDI ports), else Web MIDI's output of that name. Returns whether it went anywhere. LUNA answers a send to a port
 * that has gone with success, so the device is looked up on every send.
 */
function sendMidi(device, bytes) {
  if (DEMO) return false;
  try {
    const out = luna && outputDevice(device);
    if (out) {
      const [status, data1 = 0, data2 = 0] = bytes;
      new Luna.SendMidi(luna).sendMidiToOutput(out, status, data1, data2).catch((e) => report(`feedback to ${device} failed: ${e.code ?? ''} ${e.message}`));
      return true;
    }
    // Web MIDI names the hardware without LUNA's " (2)" suffix.
    const plain = String(device).replace(/\s*\(\d+\)$/, '');
    if (midiIn.access) {
      const outs = [...midiIn.access.outputs.values()];
      const o = outs.find((x) => x.name === plain) ?? outs.find((x) => x.name?.startsWith(plain)) ?? outs.find((x) => x.name?.includes(plain));
      if (o) {
        o.send(bytes);
        return true;
      }
    }
  } catch (e) {
    report(`feedback to ${device} failed: ${e.message}`);
  }
  return false;
}

/** A line for the console. */
function report(text) {
  console.log(text);
}
window.addEventListener('error', (e) => report(`error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => report(`unhandled: ${e.reason?.code ?? ''} ${e.reason?.message ?? e.reason}`));

function onMidi(data, device) {
  if (prefs.device && !AddOnLogic.sameDevice(device, prefs.device)) return;
  const msg = AddOnLogic.parseMidi(data);
  if (!msg) return;
  midiIn.lastHit = performance.now();
  if (mapper) {
    const hits = mapper.learning ? -1 : mapper.all().filter((m) => mapper.matches(m.source, { device, type: msg.type, channel: msg.channel, number: msg.number })).length;
    mapper.midi(msg, device);
    // Say what arrived and what it did, at most a few lines a second.
    const now = performance.now();
    if (now - (onMidi.said ?? 0) > 300) {
      onMidi.said = now;
      report(`midi ${AddOnLogic.sourceLabel(msg)} = ${msg.raw} ch ${msg.channel} from ${device} (${midiIn.via}): ${hits < 0 ? 'learning' : hits ? `${hits} mapping(s)` : 'no mapping'}`);
    }
  }
}

/** Pick the live source and list its inputs. Called whenever any source's devices change. */
function chooseVia() {
  const was = midiIn.via;
  let via = 'none';
  let names = [];
  if (midiIn.ready && portDevices().length) [via, names] = ['luna', portDevices().map((d) => d.name.value)];
  else if (midiIn.access?.inputs.size > 0) [via, names] = ['webmidi', [...midiIn.access.inputs.values()].map((i) => i.name)];
  else if (midiIn.ready && realDevices().length) [via, names] = ['last', realDevices().map((d) => d.name.value)];
  midiIn.via = via;
  midiIn.inputs = [...new Set(names)];
  renderDevices();
  if (via !== was) {
    report(`MIDI via ${via}: ${midiIn.inputs.length} input(s)`);
    mapper?.syncFeedback();
  }
}

/** luna: listen to each port on its own, so every message says which device sent it. */
function listenToPorts() {
  const devices = portDevices();
  const key = devices.map((d) => `${d.name.value}@${d.inputPort.path}`).join('|');
  if (key !== midiIn.listeningTo || midiIn.stops.length !== devices.length) {
    midiIn.listeningTo = key;
    for (const stop of midiIn.stops) stop();
    const input = new Luna.MidiInput(luna);
    midiIn.stops = devices.map((d) => {
      const name = d.name.value;
      return input.listen(d, (m) => from('luna')([m.status, m.data1, m.data2], name), {
        onGap: ({ missed, dropped }) => report(`midi gap from ${name}: ${missed} batch(es) missed, ${dropped} dropped`),
      });
    });
  }
}

/**
 * last: follow each device's last controller and last note. LUNA pushes `last_midi_control` and
 * `last_midi_note` ([status, data1, data2]) to whoever subscribes to the device by path (the SDK's
 * props alone are not kept live), so one recursive subscription on the MIDI folder hears them all.
 */
function watchLast() {
  if (midiIn.lastStops.length) return;
  midiIn.lastStops = [
    luna.raw.subscribe(
      luna.midiDevices.path,
      (e) => {
        const m = /\/midi\/([^/]+)\/last_midi_(control|note)$/.exec(e.path ?? '');
        if (!m || !Array.isArray(e.data) || e.data[0] === 255 || e.data[0] === undefined) return;
        const device = luna.midiDevices.items.find((d) => d.id === m[1]);
        if (device?.isPhysical && device.name.value) from('last')(e.data, device.name.value);
      },
      { recursive: true },
    ),
  ];
}

function devicesChanged() {
  if (!midiIn.ready) return;
  listenToPorts();
  watchLast();
  chooseVia();
}

async function startMidi() {
  // Web MIDI, where the page has it. WebKit (LUNA's window on macOS) has none; where it exists it
  // can still refuse, hang, or see no devices, and then LUNA's own list is used.
  if (navigator.requestMIDIAccess && !DEMO) {
    Promise.race([navigator.requestMIDIAccess({ sysex: false }), new Promise((_, no) => setTimeout(() => no(new Error('Web MIDI did not answer')), 3000))])
      .then((access) => {
        midiIn.access = access;
        const wire = () => {
          for (const input of access.inputs.values()) input.onmidimessage = (e) => from('webmidi')(e.data, input.name);
          chooseVia();
        };
        access.onstatechange = wire;
        wire();
      })
      .catch((e) => console.warn('Web MIDI unavailable', e));
  }
  try {
    const watcher = luna.midiDevices.watch();
    await watcher.ready;
    midiIn.ready = true;
    luna.midiDevices.onChange(devicesChanged);
    luna.status.onChange(() => {
      // After LUNA reconnects the SDK restores its subscriptions; make sure ours exist.
      if (luna.status.value === 'connected') {
        midiIn.listeningTo = '';
        devicesChanged();
      }
    });
  } catch (e) {
    report(`MIDI devices unavailable: ${e.code ?? ''} ${e.message}`);
  }
  devicesChanged();
}

function renderDevices() {
  const sel = $('device');
  const known = (n) => midiIn.inputs.some((i) => AddOnLogic.sameDevice(i, n));
  const names = [...new Set([...midiIn.inputs, ...(prefs.device && !known(prefs.device) ? [prefs.device] : [])])];
  const none = midiIn.ready ? 'No MIDI inputs found' : 'Looking for MIDI…';
  sel.innerHTML =
    (midiIn.inputs.length ? `<option value="">All inputs (${midiIn.inputs.length})</option>` : `<option value="">${none}</option>`) +
    names.map((n) => `<option value="${esc(n)}">${esc(n)}${known(n) ? '' : ' (offline)'}</option>`).join('');
  sel.value = names.find((n) => AddOnLogic.sameDevice(n, prefs.device)) ?? '';
  $('midi-dot').classList.toggle('live', midiIn.inputs.length > 0);
  $('midi-chip').title = { luna: 'MIDI from LUNA', webmidi: 'MIDI from the browser (Web MIDI)', last: "MIDI from LUNA's last-controller values: knobs work; no feedback, and an identical repeat can be missed.", none: 'Which MIDI input MIDI Learn listens to' }[midiIn.via];
}
$('device').onchange = () => {
  prefs.device = $('device').value;
  savePrefs();
};

// The input list is our own menu, not the native <select> popup: macOS opens that one over the
// selected item, so with many devices and the last one chosen it runs off the top of the screen.
function openDeviceMenu() {
  const menu = $('device-menu');
  const sel = $('device');
  menu.innerHTML = [...sel.options].map((o) => `<button role="option" data-v="${esc(o.value)}" aria-selected="${o.value === sel.value}">${esc(o.textContent)}</button>`).join('');
  menu.hidden = false;
  const chip = $('midi-chip').getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(120, innerHeight - chip.bottom - 14)}px`;
  menu.style.top = `${chip.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(chip.left, innerWidth - menu.offsetWidth - 8))}px`;
  (menu.querySelector('[aria-selected="true"]') ?? menu.querySelector('button'))?.focus({ preventScroll: true });
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}
function closeDeviceMenu() {
  $('device-menu').hidden = true;
}
$('midi-chip').onclick = () => ($('device-menu').hidden ? openDeviceMenu() : closeDeviceMenu());
$('midi-chip').onkeydown = (e) => {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
    e.preventDefault();
    openDeviceMenu();
  }
};
$('device-menu').onclick = (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  $('device').value = b.dataset.v;
  $('device').onchange();
  closeDeviceMenu();
  $('midi-chip').focus();
};

// ---- Rendering ----------------------------------------------------------------------------
// Mapper changes arrive per MIDI message; paint at most once a frame.
let frame = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint();
  });
}

function paint() {
  paintSessionSwitches();
  paintShift();
  paintLearn();
  paintMonitor();
  paintMaps();
  paintPicked();
}

let announced;
let announcedReset;
function paintLearn() {
  if (mapper?.lastReset && mapper.lastReset !== announcedReset) {
    announcedReset = mapper.lastReset;
    toast(`Reset ${mapper.lastReset.label} · ${mapper.lastReset.where}`);
  }
  const on = !!mapper?.learning;
  if (paintLearn.was !== on) {
    paintLearn.was = on;
    report(`learn ${on ? 'on' : 'off'}`);
    // A finished or cancelled learn leaves the editor empty for the next one.
    if (!on) {
      $('src-num').value = '';
      $('src-ch').value = '';
    }
  }
  if (mapper?.lastLearned && mapper.lastLearned !== announced) {
    announced = mapper.lastLearned;
    const r = mapper.rows().find((x) => x.mapping.id === announced);
    if (r) {
      const src = r.shift ? `Shift + ${r.source}` : r.source;
      toast(r.plugin ? `Plugins: ${src} → ${r.target} (${r.mapping.target.pluginName}, any instance)` : r.mighty ? `Click & Turn: ${r.source}. Click any control in LUNA` : r.focus ? `Channel Focus: ${src} → ${r.target} (${r.where})` : `Mapped ${src} → ${r.target} (${r.where})`);
    }
    setTimeout(() => {
      if (mapper?.lastLearned === announced) {
        mapper.lastLearned = undefined;
        schedule(); // paintRow drops the highlight; no rebuild
      }
    }, 2500);
  }
  paintLearnBar(on);
  const t = mapper?.pending.target;
  const s = mapper?.pending.source;
  const target = $('slot-target');
  target.classList.toggle('got', !!t);
  target.classList.toggle('wait', !t);
  target.classList.toggle('armed', on && !t);
  target.querySelector('.what').innerHTML = t ? `${esc(t.label)}<small>${esc(t.kind === 'command' ? 'Command' : t.kind === 'focus' ? `${t.area} · focused track` : t.kind === 'mighty' ? 'whatever you click in LUNA' : t.kind === 'plugin' ? `${t.pluginName} · any instance` : `${t.channel} · ${t.area}`)}</small>` : 'None';
  const source = $('slot-source');
  source.classList.toggle('got', !!s);
  source.classList.toggle('wait', !s);
  source.classList.toggle('armed', on && !s);
  // MIDI that arrives while learning fills the editor, so learning and typing are one control.
  if (s && s !== paintLearn.shown) fillEditor(s);
  paintLearn.shown = s;
  paintEditor();
}

// ---- Learning inside each section ---------------------------------------------------------
// Each section has its own Learn button; while one learns, the learn bar (Parameter + MIDI, with
// the typed-CC editor) opens at the top of that section. Hold (switch in the learn bar, or
// Shift-click / right-click a Learn button) latches it:
// keep learning, one mapping after another, until the button is pressed again or Esc.
const LEARN_SECTIONS = { map: 'maps-sect', focus: 'focus-sect', mighty: 'mighty-sect', plugin: 'plugin-sect' };
const LEARN_FOLDS = { map: 'maps', focus: 'focus', mighty: 'mighty', plugin: 'plugins' };

// The Commands list inside the learn bar: play, record, undo… to pick without scrolling to Parameters.
function buildCmdList() {
  const box = $('cmd-list');
  box.innerHTML = '';
  for (const c of AddOnLogic.COMMANDS) {
    const b = document.createElement('button');
    b.className = 'param';
    b.dataset.key = c.id;
    b.innerHTML = `<span><b>${esc(c.label)}<i class="mapped" hidden></i></b><small>Command</small></span><span class="v"></span>`;
    b.onclick = () => {
      mapper?.pick(AddOnLogic.commandTarget(c.id));
      setCmdList(false);
    };
    box.appendChild(b);
  }
}
function setCmdList(open) {
  $('cmd-list').hidden = !open;
  $('cmd-toggle').setAttribute('aria-expanded', String(open));
  if (open) {
    if (!$('cmd-list').childElementCount) buildCmdList();
    paintBrowseMarks();
    paintPicked();
  }
}
$('cmd-toggle').onclick = () => setCmdList($('cmd-list').hidden);

function paintLearnBar(on) {
  const bar = $('learnbar');
  const mode = mapper?.learnMode ?? 'map';
  const showBar = on && mode !== 'shift';
  bar.hidden = !showBar;
  bar.classList.toggle('proxy', mode === 'mighty');
  bar.classList.toggle('no-cmd', mode !== 'map');
  if (!showBar || mode !== 'map') setCmdList(false);
  const done = showBar && mapper?.latch ? 'Stop' : 'Done';
  // Hold sits just right of the learning section's Learn button, only while it learns. Click & Turn
  // is one knob, so it has no Hold.
  const hold = $('learn-hold');
  const pill = document.querySelector(`.learn-pill[data-learn="${mode}"]`);
  hold.hidden = !(showBar && mode !== 'mighty' && pill);
  if (!hold.hidden && pill.nextElementSibling !== hold) pill.after(hold);
  hold.setAttribute('aria-pressed', String(!!(showBar && mapper?.latch)));
  if ($('learn-done').textContent !== done) $('learn-done').textContent = done;
  if (showBar) {
    const body = $(LEARN_SECTIONS[mode])?.querySelector(':scope > .body');
    if (body && bar.parentElement !== body) body.insertBefore(bar, body.firstChild);
    // Learning in a folded section opens it, so the learn bar is in view.
    if (prefs.fold[LEARN_FOLDS[mode]]) {
      prefs.fold = { ...prefs.fold, [LEARN_FOLDS[mode]]: false };
      savePrefs();
      paintFolds();
    }
  }
  for (const b of document.querySelectorAll('.learn-pill[data-learn]')) {
    const mine = on && mode === b.dataset.learn;
    const latched = mine && !!mapper?.latch;
    b.setAttribute('aria-pressed', String(mine));
    b.dataset.latched = String(latched);
    const idle = b.dataset.learn === 'mighty' && mapper?.mighty ? 'Relearn' : 'Learn';
    const text = latched ? 'Holding' : mine ? 'Learning' : idle;
    if (b.textContent !== text) b.textContent = text;
  }
}

/** Start or stop learning in one section; `latch` keeps it going for several mappings. */
function toggleLearn(mode, { latch = false } = {}) {
  if (!mapper) return;
  const mine = mapper.learning && mapper.learnMode === mode;
  if (mine && !latch) mapper.setLearning(false);
  else mapper.setLearning(true, mode, { latch });
}

for (const b of document.querySelectorAll('.learn-pill[data-learn]')) {
  // Shift-click starts learning in Hold, like the right-click menu (which LUNA's window may not show).
  b.onclick = (e) => toggleLearn(b.dataset.learn, { latch: e.shiftKey && b.dataset.learn !== 'mighty' });
  b.oncontextmenu = (e) => {
    e.preventDefault();
    if (b.dataset.learn === 'mighty') return toggleLearn('mighty'); // one knob: nothing to latch
    openLearnMenu(b, e.clientX, e.clientY);
  };
}

let learnMenuFor;
function openLearnMenu(button, x, y) {
  const menu = $('learn-menu');
  learnMenuFor = button.dataset.learn;
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menu.querySelector('button').focus();
}
function closeLearnMenu() {
  $('learn-menu').hidden = true;
  learnMenuFor = undefined;
}
for (const item of $('learn-menu').querySelectorAll('button')) {
  item.onclick = () => {
    const mode = learnMenuFor;
    closeLearnMenu();
    if (mode) toggleLearn(mode, { latch: item.dataset.latch === 'true' });
  };
}
$('learn-done').onclick = () => mapper?.setLearning(false);
$('learn-hold').onclick = () => {
  if (!mapper?.learning) return;
  const on = !mapper.latch;
  $('learn-hold').setAttribute('aria-pressed', String(on));
  mapper.setHold(on);
  report(`hold ${on ? 'on' : 'off'} (${mapper.learnMode})`);
};

// ---- Help ---------------------------------------------------------------------------------
function toggleHelp(open = $('help').hidden) {
  if (open) {
    closeColors();
    closeTemplates();
    closeShift();
  }
  $('help').hidden = !open;
}
$('open-help').onclick = (e) => {
  e.stopPropagation();
  toggleHelp();
};

// ---- The MIDI editor: learn it, or type it --------------------------------------------------
const editor = { type: 'cc' };
$('src-ch').innerHTML = '<option value="">Any</option>' + Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');

function fillEditor(src) {
  editor.type = src.type === 'program' ? 'cc' : src.type;
  $('src-num').value = src.type === 'pitch' ? '' : src.type === 'note' ? AddOnLogic.noteName(src.number) : String(src.number);
  $('src-ch').value = src.channel === null ? '' : String(src.channel);
}

function typedSource() {
  return AddOnLogic.manualSource({ type: editor.type, number: $('src-num').value, channel: $('src-ch').value });
}

function paintEditor() {
  for (const b of $('src-type').children) b.setAttribute('aria-pressed', String(b.dataset.t === editor.type));
  $('src-num').disabled = editor.type === 'pitch';
  $('src-num').placeholder = editor.type === 'note' ? 'C3' : editor.type === 'pitch' ? '—' : '#';
  const ok = !!typedSource();
  $('src-num').classList.toggle('bad', !ok && $('src-num').value !== '');
  $('src-assign').disabled = !(ok && mapper?.pending.target);
}

function assignTyped() {
  const src = typedSource();
  if (!mapper || !src || !mapper.pending.target) return;
  mapper.assign(src);
  $('src-num').blur();
}

$('src-type').onclick = (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  editor.type = b.dataset.t;
  paintEditor();
  if (editor.type !== 'pitch') $('src-num').focus();
};
$('src-num').oninput = paintEditor;
$('src-ch').onchange = paintEditor;
$('src-num').onkeydown = (e) => {
  if (e.key === 'Enter') assignTyped();
};
$('src-assign').onclick = assignTyped;

// ---- Folding sections ---------------------------------------------------------------------
function paintFolds() {
  for (const b of document.querySelectorAll('.fold')) {
    const key = b.dataset.fold;
    const folded = !!prefs.fold[key];
    b.setAttribute('aria-expanded', String(!folded));
    b.closest('.sect, .col').classList.toggle('folded', folded);
    // The Learn column narrows only when everything in it is folded: Click & Turn lives there too.
    const narrow = key === 'learn' ? folded && !!prefs.fold.mighty : folded;
    $('board').classList.toggle(`fold-${key}`, narrow);
  }
}
// Clicks made before this script ran were handled by the page's early handler: adopt them.
document.removeEventListener('click', globalThis.__earlyFold);
for (const [key, flipped] of Object.entries(globalThis.__earlyFolds ?? {})) {
  if (flipped) prefs.fold = { ...prefs.fold, [key]: !prefs.fold[key] };
}
if (Object.values(globalThis.__earlyFolds ?? {}).some(Boolean)) savePrefs();
for (const b of document.querySelectorAll('.fold')) {
  b.onclick = () => {
    prefs.fold = { ...prefs.fold, [b.dataset.fold]: !prefs.fold[b.dataset.fold] };
    savePrefs();
    paintFolds();
  };
}
paintFolds();

function paintMonitor() {
  const last = mapper?.lastSource;
  // Flash only for a new message, not on every repaint.
  if (!last || last.at === paintMonitor.at) return;
  paintMonitor.at = last.at;
  const dot = $('midi-dot');
  dot.classList.add('hit');
  clearTimeout(paintMonitor.t);
  paintMonitor.t = setTimeout(() => dot.classList.remove('hit'), 120);
}

const rowOrder = []; // mapping ids in the order they first appeared: rows never jump around
/**
 * The two lists: regular mappings and Channel Focus mappings. Each keeps its own structure
 * signature, the rows it has shown (so only new ones animate in) and the live-value bindings of
 * its rows, so rebuilding one never disturbs the other.
 */
const lists = {
  maps: { ul: 'maps', count: 'map-count', sig: '', shown: new Set(), bind: new Luna.Bindings(), empty: (total) => (total ? 'None' : 'No mappings yet') },
  focus: { ul: 'focus-maps', count: 'focus-count', sig: '', shown: new Set(), bind: new Luna.Bindings(), empty: () => 'No Channel Focus mappings yet' },
  plugins: {
    ul: 'plugin-maps',
    count: 'plugin-count',
    sig: '',
    shown: new Set(),
    bind: new Luna.Bindings(),
    empty: () => {
      const fp = mapper?.focusPlugin();
      return fp ? `No map for ${fp.pluginName} yet` : 'Turn a knob in a plugin’s window to focus it';
    },
  },
};
function resetLists() {
  for (const l of Object.values(lists)) {
    l.sig = '';
    l.shown = new Set();
    l.bind.clear();
  }
}

/**
 * What decides the rows and their markup. Everything that can change in place (mode, invert,
 * feedback, range, input, global) is left out, so clicking a toggle or dragging the range never
 * rebuilds the list; paintRow patches those.
 */
function structure(list) {
  return JSON.stringify([
    prefs.filter,
    list.map((r) => [r.mapping.id, r.mapping.source.type, r.mapping.source.number, r.mapping.source.channel, r.mapping.target, r.missing, r.entry?.path, r.entry?.switch]),
  ]);
}

function paintMaps() {
  if (!mapper) return;
  const all = mapper.rows();
  for (const r of all) if (!rowOrder.includes(r.mapping.id)) rowOrder.push(r.mapping.id);
  all.sort((a, b) => rowOrder.indexOf(a.mapping.id) - rowOrder.indexOf(b.mapping.id));
  const regular = all.filter((r) => !r.focus && !r.mighty && !r.plugin);
  const fp = mapper.focusPlugin();
  const shown = {
    maps: [regular.filter((r) => prefs.filter === 'all' || (prefs.filter === 'global') === r.global), regular.length],
    focus: [all.filter((r) => r.focus), all.filter((r) => r.focus).length],
    plugins: [all.filter((r) => r.plugin && r.active), mapper.pluginMappings.length],
  };
  const now = Date.now();
  for (const [key, [list, total]] of Object.entries(shown)) {
    const state = lists[key];
    const sig = structure(list) + (key === 'focus' ? `|${mapper.focusTrack()?.id}` : key === 'plugins' ? `|${fp?.path}` : '');
    if (sig !== state.sig) {
      state.sig = sig;
      buildList(state, list, total);
    }
    paintRows(list, now);
  }
  paintFocusHead();
  paintPluginHead(fp);
  paintMighty(all.find((r) => r.mighty), now);
  paintSummaries(all, regular);
}

/** What each folded section shows in its header: what it's controlling right now, if anything. */
function paintSummaries(all, regular) {
  const put = (id, text) => $(id).textContent !== text && ($(id).textContent = text);
  const mighty = all.find((r) => r.mighty);
  // What's controlled comes first, so it survives the ellipsis in a narrow column.
  put('mighty-sum', mighty ? (mighty.entry ? `${mighty.target} · ${mighty.where}${mighty.hold ? ' · held' : ''} (${mighty.source})` : `Click a control (${mighty.source})`) : '');
  const last = regular.filter((r) => r.movedAt).sort((a, b) => b.movedAt - a.movedAt)[0];
  put('maps-sum', last ? `${last.target} · ${last.where} (${last.source})` : regular.length ? `${regular.length} mapping${regular.length === 1 ? '' : 's'}` : '');
  const focus = all.filter((r) => r.focus);
  const track = mapper.focusTrack()?.name.value;
  const fp = mapper.focusPlugin();
  const active = mapper.activePluginMappings().length;
  put('plugin-sum', fp ? `${fp.pluginName} · ${fp.channel} · ${fp.area.split(' · ')[0]}${mapper.pluginLock ? ' (locked)' : ''} · ${active} control${active === 1 ? '' : 's'}` : mapper.pluginMappings.length ? `${mapper.pluginMaps().length} saved map${mapper.pluginMaps().length === 1 ? '' : 's'}` : '');
  put('focus-sum', focus.length ? `${track ?? 'No track'}${mapper.focusLock ? ' (locked)' : ''} · ${focus.length} control${focus.length === 1 ? '' : 's'}` : '');
}

// ---- Saved with the session ----------------------------------------------------------------
// Session mappings always live in the session. Click & Turn, Channel Focus and the plugin maps are
// one layout for every session until their "Save with this session" switch is on.
function paintSessionSwitches() {
  for (const b of document.querySelectorAll('[data-session]')) {
    const on = !!mapper?.savedWithSession(b.dataset.session);
    b.setAttribute('aria-pressed', String(on));
    b.disabled = !mapper?.sessionStore?.available;
    if (b.disabled) b.title = "This LUNA doesn't keep Add On settings in the session, so this layout is shared by every session";
  }
}
for (const b of document.querySelectorAll('[data-session]')) {
  b.onclick = () => {
    if (!mapper) return;
    const kind = b.dataset.session;
    const on = !mapper.savedWithSession(kind);
    if (!mapper.setSavedWithSession(kind, on)) return;
    const name = { mighty: 'Click & Turn', focus: 'Channel Focus', plugins: 'Plugin maps' }[kind];
    toast(on ? `${name} now saved with this session` : `${name} back to the layout shared by every session`);
    report(`${kind} saved with session: ${on}`);
    schedule();
  };
}

// ---- Click & Turn card ------------------------------------------------------------------------
const mightyBind = new Luna.Bindings();
let mightyBound; // the control path the card's live value follows
function paintMighty(r, now) {
  const card = $('mighty');
  const learning = mapper?.learning && mapper.learnMode === 'mighty';
  card.dataset.state = r ? 'set' : 'empty';
  if (!r) {
    $('mighty-src').textContent = '—';
    $('mighty-label').textContent = learning ? 'Move a knob' : 'No knob yet';
    $('mighty-where').textContent = learning ? 'or type it in the MIDI card' : '';
    if (mightyBound) {
      mightyBind.clear();
      mightyBound = undefined;
    }
    return;
  }
  $('mighty-src').textContent = r.source;
  $('mighty-label').textContent = r.target;
  $('mighty-where').textContent = r.hold ? `${r.where} · held` : r.where;
  $('mighty-hold').setAttribute('aria-pressed', String(!!r.hold));
  $('mighty-fb').setAttribute('aria-pressed', String(!!r.mapping.feedback));
  card.classList.toggle('hit', now - r.movedAt < 160);
  const path = r.entry?.path;
  if (path !== mightyBound) {
    if (mightyBound && path) {
      card.classList.remove('retarget');
      void card.offsetWidth; // restart the pop on each new target
      card.classList.add('retarget');
    }
    mightyBound = path;
    mightyBind.clear();
    const c = r.entry?.control;
    const show = () => {
      $('mighty-display').textContent = c?.display.value ?? '';
      $('mighty-meter').style.setProperty('--v', `${Math.round((c?.normalized.value ?? 0) * 100)}%`);
    };
    show();
    if (c) {
      mightyBind.on(c.display, show);
      mightyBind.on(c.normalized, show);
    }
  }
}
$('mighty-hold').onclick = () => {
  $('mighty-hold').setAttribute('aria-pressed', String($('mighty-hold').getAttribute('aria-pressed') !== 'true'));
  mapper?.setMightyHold(!mapper.mightyHold);
};
$('mighty-fb').onclick = () => {
  if (!mapper?.mighty) return;
  $('mighty-fb').setAttribute('aria-pressed', String(!mapper.mighty.feedback));
  mapper.update(mapper.mighty.id, { feedback: !mapper.mighty.feedback });
};
$('mighty-x').onclick = () => {
  if (!mapper?.mighty) return;
  mapper.remove(mapper.mighty.id);
  toast('Click & Turn removed');
};

/** The Plugins header (which instance the maps control) and the saved-maps chips. */
function paintPluginHead(fp) {
  if (!mapper) return;
  const sel = $('plugin-focus');
  const inserts = mapper.liveInserts();
  // What the maps follow when nothing is locked: the selected track's plugin, or one touched since.
  const following = mapper.pluginLock ? undefined : fp;
  const label = (i) => `${i.pluginName} · ${i.channel} · ${i.area.split(' · ')[0]}`;
  const sig = JSON.stringify([following?.path, mapper.pluginLock, inserts.map((i) => [i.path, i.pluginName, i.channel])]);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML = `<option value="">Follow: ${esc(following ? label(following) : 'select a track or touch a plugin')}</option>` + inserts.map((i) => `<option value="${esc(i.path)}">Lock: ${esc(label(i))}</option>`).join('');
    if (document.activeElement !== sel) sel.value = mapper.pluginLock ?? '';
  }
  const mine = mapper.activePluginMappings().filter((m) => mapper.canFeedback(m));
  $('plugin-fb').setAttribute('aria-pressed', String(mine.length > 0 && mine.every((m) => m.feedback)));
  $('plugin-fb').disabled = !mine.length;
  const maps = mapper.pluginMaps();
  const chips = JSON.stringify([maps, fp?.pluginId]);
  if ($('saved-maps').dataset.sig !== chips) {
    $('saved-maps').dataset.sig = chips;
    $('saved-maps').innerHTML = maps.length
      ? `<span>Saved maps</span>${maps.map((m) => `<span class="map-chip${m.pluginId === fp?.pluginId ? ' on' : ''}" title="${esc(m.pluginName)}: ${m.count} control${m.count === 1 ? '' : 's'}">${esc(m.pluginName)} <small>${m.count}</small><button class="x" data-del="${esc(m.pluginId)}" aria-label="Delete the ${esc(m.pluginName)} map">${X}</button></span>`).join('')}`
      : '';
    for (const b of $('saved-maps').querySelectorAll('[data-del]')) {
      // Deleting a whole map takes two presses.
      b.onclick = () => {
        if (!b.classList.contains('confirm')) {
          b.classList.add('confirm');
          b.title = 'Press again to delete';
          setTimeout(() => b.classList.remove('confirm'), 3000);
          return;
        }
        const name = maps.find((m) => m.pluginId === b.dataset.del)?.pluginName;
        mapper.deletePluginMap(b.dataset.del);
        toast(`Deleted the ${name} map`);
      };
    }
  }
}
$('plugin-focus').onchange = () => mapper?.setPluginLock($('plugin-focus').value || undefined);
$('plugin-fb').onclick = () => {
  const fp = mapper?.focusPlugin();
  if (!fp) return;
  const mine = mapper.activePluginMappings().filter((m) => mapper.canFeedback(m));
  const on = !(mine.length > 0 && mine.every((m) => m.feedback));
  $('plugin-fb').setAttribute('aria-pressed', String(on));
  mapper.setPluginFeedback(on, fp.pluginId);
};

/** The Channel Focus header: which track it controls, and its Learn button. */
function paintFocusHead() {
  if (!mapper) return;
  const sel = $('focus-track');
  const track = mapper.focusTrack();
  const selected = mapper.session.focusedTrack?.value;
  const tracks = mapper.session.visibleTracks;
  const sig = JSON.stringify([selected?.id, selected?.name.value, mapper.focusLock, tracks.map((t) => [t.id, t.name.value])]);
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.innerHTML =
      `<option value="">Selected: ${esc(selected?.name.value ?? 'none')}</option>` +
      tracks.map((t) => `<option value="${esc(t.id)}">Lock: ${esc(t.name.value ?? t.id)}</option>`).join('');
    if (document.activeElement !== sel) sel.value = mapper.focusLock ?? '';
  }
  const argb = track?.color.value;
  $('focus-color').style.setProperty('--c', typeof argb === 'number' ? `#${(argb & 0xffffff).toString(16).padStart(6, '0')}` : '#888');
  const fbAble = mapper.focusMappings.filter((m) => mapper.canFeedback(m));
  const fbOn = fbAble.length > 0 && fbAble.every((m) => m.feedback);
  $('focus-fb').setAttribute('aria-pressed', String(fbOn));
  $('focus-fb').disabled = !fbAble.length;
}
$('focus-fb').onclick = () => {
  if (!mapper) return;
  const able = mapper.focusMappings.filter((m) => mapper.canFeedback(m));
  const on = !(able.length > 0 && able.every((m) => m.feedback));
  $('focus-fb').setAttribute('aria-pressed', String(on));
  mapper.setFocusFeedback(on);
  report(`channel focus feedback ${on ? 'on' : 'off'} for ${able.length} mapping(s)`);
};
$('focus-track').onchange = () => mapper?.setFocusLock($('focus-track').value || undefined);

function paintRows(list, now) {
  for (const r of list) {
    const li = document.querySelector(`.map[data-id="${r.mapping.id}"]`);
    if (!li) continue;
    paintRow(li, r);
    li.classList.toggle('hit', now - r.movedAt < 160);
    if (now - r.movedAt < 160) setTimeout(schedule, 170);
  }
}

/** Bring one row's tags and edit controls in line with its mapping, without rebuilding it. */
function paintRow(li, r) {
  const m = r.mapping;
  const q = (sel) => li.querySelector(sel);
  const set = (el, attr, value) => el && el.getAttribute(attr) !== value && el.setAttribute(attr, value);
  q('.tag.fb').hidden = !m.feedback;
  q('.tag.shift').hidden = !r.shift;
  q('.tag.global').hidden = !r.global;
  const mode = MODES[m.mode] ?? m.mode;
  if (q('.tag.mode').textContent !== mode) q('.tag.mode').textContent = mode;
  li.classList.toggle('learned', mapper.lastLearned === m.id);
  li.querySelectorAll('.mode-seg button').forEach((b) => set(b, 'aria-pressed', String(modeIs(m, b.dataset.mode))));
  set(q('.inv'), 'aria-pressed', String(!!m.invert));
  set(q('.fb'), 'aria-pressed', String(!!m.feedback));
  set(q('.shf'), 'aria-pressed', String(!!r.shift));
  set(q('.glob'), 'aria-pressed', String(r.global));
  const dev = q('.dev');
  if (dev && document.activeElement !== dev && dev.value !== (m.source.device ?? '')) dev.value = m.source.device ?? '';
}

/**
 * A two-ended range on one line, in MIDI steps (0..127): drag either cap or anywhere on the line
 * (the nearer cap follows), or use the arrow keys (Shift for 10, Home/End). `commit(lo, hi)`
 * runs on release, so the mapping list never rebuilds mid-drag.
 */
function wireRange(root, lo, hi, commit) {
  const track = root.querySelector('.track');
  const fill = root.querySelector('.fill');
  const caps = { lo: root.querySelector('[data-end="lo"]'), hi: root.querySelector('[data-end="hi"]') };
  const v = { lo, hi };
  const paint = () => {
    for (const end of ['lo', 'hi']) {
      caps[end].style.left = `${(v[end] / 127) * 100}%`;
      caps[end].setAttribute('aria-valuenow', String(v[end]));
      root.querySelector(`.${end}`).textContent = String(v[end]);
    }
    fill.style.left = `${(v.lo / 127) * 100}%`;
    fill.style.width = `${((v.hi - v.lo) / 127) * 100}%`;
  };
  const set = (end, n) => {
    n = Math.max(0, Math.min(127, Math.round(n)));
    v[end] = end === 'lo' ? Math.min(n, v.hi) : Math.max(n, v.lo);
    paint();
  };
  const done = () => (v.lo !== lo || v.hi !== hi) && commit(v.lo, v.hi);
  const at = (e) => {
    const r = track.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * 127;
  };
  let drag;
  root.querySelector('.rail').onpointerdown = (e) => {
    e.preventDefault();
    const x = at(e);
    const end = e.target.dataset?.end ?? (Math.abs(x - v.lo) < Math.abs(x - v.hi) || (v.lo === v.hi && x < v.lo) ? 'lo' : 'hi');
    drag = end;
    caps[end].classList.add('drag');
    caps[end].focus({ preventScroll: true });
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    set(end, x);
  };
  root.querySelector('.rail').onpointermove = (e) => drag && set(drag, at(e));
  root.querySelector('.rail').onpointerup = root.querySelector('.rail').onpointercancel = () => {
    if (!drag) return;
    caps[drag].classList.remove('drag');
    drag = undefined;
    done();
  };
  for (const end of ['lo', 'hi']) {
    caps[end].onkeydown = (e) => {
      const step = e.shiftKey ? 10 : 1;
      const next = { ArrowLeft: v[end] - step, ArrowDown: v[end] - step, ArrowRight: v[end] + step, ArrowUp: v[end] + step, Home: 0, End: 127 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      set(end, next);
    };
    caps[end].onkeyup = (e) => /^(Arrow|Home|End)/.test(e.key) && done();
  }
  paint();
}

const MODES = { absolute: 'Follow', toggle: 'Toggle', trigger: 'Follow' }; // 'trigger' is a button's older name for Follow
/** Which Mode button is lit: Toggle, or Follow for anything else. */
const modeIs = (m, k) => (k === 'toggle') === (m.mode === 'toggle');
const MODE_TIPS = {
  absolute: 'Control: follows the knob or fader. Button: fires on the press (buttons that send on, then off on release).',
  toggle: 'Control: each press flips it. Button: fires on every press of a latching button (sends on, then off on the next press).',
};

function buildList(state, list, total) {
  state.bind.clear();
  const ul = $(state.ul);
  $(state.count).textContent = total ? String(total) : '';
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${state.empty(total)}</li>`;
    paintBrowseMarks();
    return;
  }
  ul.innerHTML = '';
  const before = state.shown;
  state.shown = new Set(list.map((r) => r.mapping.id));
  // On the first build after a session binds, nothing counts as new.
  if (!before.size) for (const id of state.shown) before.add(id);
  for (const r of list) {
    const m = r.mapping;
    const li = document.createElement('li');
    li.className = 'map';
    li.dataset.id = m.id;
    if (!before.has(m.id)) li.classList.add('new');
    li.addEventListener('animationend', (e) => e.animationName === 'rise' && li.classList.remove('new', 'opening'));
    li.classList.toggle('missing', r.missing);
    li.classList.toggle('open', openRows.has(m.id));
    li.classList.toggle('learned', mapper.lastLearned === m.id);
    const isControl = m.target.kind === 'control' || m.target.kind === 'focus' || m.target.kind === 'plugin';
    // Commands and automation mode buttons are buttons: Follow fires on the press, Toggle on each
    // press of a latching button.
    const buttonTarget = m.target.kind === 'command' || (m.target.kind === 'automation' && m.target.action !== 'knob');
    const continuous = isControl && r.entry && !r.entry.switch;
    li.innerHTML = `
      <div class="row">
        <span class="src" title="${esc(`${r.source}, channel ${r.channel}${r.device ? `, ${r.device}` : ', any input'}`)}">${esc(r.source)}</span>
        <span class="tgt"><b>${esc(r.target)}</b><small>${esc(r.missing ? `${r.where} · ${r.missingWhy}` : r.where)}</small></span>
        <span class="val">${isControl ? `<span class="d">${esc(r.display)}</span>${continuous ? '<span class="meter"><i></i></span>' : ''}` : r.automation ? `<span class="d">${esc(r.display)}</span>` : ''}</span>
        <span class="tags"><span class="tag fb" title="Feedback on: the controller follows LUNA"${m.feedback ? '' : ' hidden'}>${FB_ICON}</span><span class="tag shift" title="Active when Shift is on"${r.shift ? '' : ' hidden'}>Shift</span><span class="tag global"${r.global ? '' : ' hidden'}>Global</span><span class="tag mode">${MODES[m.mode] ?? m.mode}</span><button class="more" aria-label="Edit mapping" aria-expanded="${openRows.has(m.id)}">${CHEVRON}</button><button class="x" aria-label="Delete mapping">${X}</button></span>
      </div>
      <div class="edit">
        <div class="lbl">MIDI<span class="line src-line"><select class="s-type" aria-label="Message">${[['cc', 'CC'], ['note', 'Note'], ['pitch', 'Bend'], ['program', 'Program']].map(([k, v]) => `<option value="${k}"${m.source.type === k ? ' selected' : ''}>${v}</option>`).join('')}</select><input class="s-num" inputmode="numeric" maxlength="4" aria-label="Number" value="${esc(m.source.type === 'pitch' ? '' : m.source.type === 'note' ? AddOnLogic.noteName(m.source.number) : m.source.type === 'program' ? m.source.number + 1 : m.source.number)}"${m.source.type === 'pitch' ? ' disabled' : ''}><select class="s-ch" aria-label="Channel"><option value="">Any ch</option>${Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}"${m.source.channel === i + 1 ? ' selected' : ''}>Ch ${i + 1}</option>`).join('')}</select></span></label>
        ${isControl || buttonTarget ? `<div class="lbl">Mode<span class="line"><span class="segments mode-seg">${['absolute', 'toggle'].map((k) => `<button data-mode="${k}" aria-pressed="${modeIs(m, k)}" title="${MODE_TIPS[k]}">${MODES[k]}</button>`).join('')}</span></span></div>` : ''}
        ${continuous ? `<div class="lbl">Range<span class="range"><b class="lo">${Math.round(m.min * 127)}</b><span class="rail"><span class="track"><i class="fill"></i><button type="button" class="cap" data-end="lo" role="slider" aria-label="Lowest value" aria-valuemin="0" aria-valuemax="127"></button><button type="button" class="cap" data-end="hi" role="slider" aria-label="Highest value" aria-valuemin="0" aria-valuemax="127"></button></span></span><b class="hi">${Math.round(m.max * 127)}</b></span></div>` : ''}
        <div class="lbl">Options<span class="line">${continuous ? `<button class="switch inv" aria-pressed="${!!m.invert}"><i></i>Invert</button>` : ''}<button class="switch shf" aria-pressed="${!!r.shift}" title="Active only when Shift is on (lets one button have two functions)"><i></i>Shift</button>${r.focus || r.plugin ? '' : `<button class="switch glob" aria-pressed="${r.global}" title="A global mapping works in every session"><i></i>Global</button>`}${mapper.canFeedback(m) ? `<button class="switch fb" aria-pressed="${!!m.feedback}" title="Send LUNA's value back to the controller, so motorized knobs and button lights follow"><i></i>Feedback</button>` : ''}</span></div>
        <div class="lbl" title="The MIDI input this mapping listens to, and where its feedback goes">Device<span class="line"><select class="dev">${[...new Set([m.source.device, ...midiIn.inputs].filter(Boolean))].map((n) => `<option value="${esc(n)}"${m.source.device === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value=""${m.source.device === null ? ' selected' : ''}>Any input</option></select></span></div>
      </div>`;
    const q = (s) => li.querySelector(s);
    q('.x').onclick = () => {
      openRows.delete(m.id);
      mapper.remove(m.id);
      toast(`Removed ${r.source} → ${r.target}`);
    };
    // Opening a row only changes classes; nothing is rebuilt.
    q('.more').onclick = () => {
      const open = !openRows.has(m.id);
      open ? openRows.add(m.id) : openRows.delete(m.id);
      li.classList.toggle('open', open);
      li.classList.toggle('opening', open);
      q('.more').setAttribute('aria-expanded', String(open));
    };
    // Toggles flip at once and save; paintRow keeps them in step with the model afterwards.
    const flip = (btn, patch) => {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('aria-pressed') !== 'true'));
      mapper.update(m.id, patch());
    };
    li.querySelectorAll('.mode-seg button').forEach((b) => (b.onclick = () => mapper.update(m.id, { mode: b.dataset.mode })));
    if (q('.inv')) q('.inv').onclick = () => flip(q('.inv'), () => ({ invert: !m.invert }));
    if (q('.shf')) q('.shf').onclick = () => flip(q('.shf'), () => ({ shift: !m.shift }));
    if (q('.fb'))
      q('.fb').onclick = () => {
        flip(q('.fb'), () => ({ feedback: !m.feedback }));
        report(`feedback ${m.feedback ? 'on' : 'off'} for ${r.source} → ${r.target} (${m.scope}${m.scope === 'focus' ? `, focus on ${mapper.focusTrack()?.name.value ?? 'no track'}` : ''})`);
      };
    if (q('.glob')) q('.glob').onclick = () => {
      const global = m.scope !== 'global';
      flip(q('.glob'), () => ({ scope: global ? 'global' : 'session' }));
      toast(global ? `${r.source} now works in every session` : `${r.source} now belongs to this session only`);
    };
    q('.dev').onchange = (e) => mapper.update(m.id, { source: { device: e.target.value || null } });
    const retype = () => {
      const type = q('.s-type').value;
      q('.s-num').disabled = type === 'pitch';
      const src = AddOnLogic.manualSource({ type, number: q('.s-num').value, channel: q('.s-ch').value, device: m.source.device });
      q('.s-num').classList.toggle('bad', !src);
      if (src && AddOnLogic.sourceKey(src) !== AddOnLogic.sourceKey(m.source)) mapper.update(m.id, { source: src });
    };
    q('.s-type').onchange = q('.s-ch').onchange = retype;
    q('.s-num').onchange = retype;
    q('.s-num').onkeydown = (e) => e.key === 'Enter' && retype();
    if (q('.range')) wireRange(q('.range'), Math.round(m.min * 127), Math.round(m.max * 127), (lo, hi) => mapper.update(m.id, { min: lo / 127, max: hi / 127 }));
    if (r.automation && r.track) {
      const d = q('.val .d');
      const labels = { off: 'Off', read: 'Read', write: 'Write', touch: 'Touch', latch: 'Latch' };
      const show = () => d && (d.textContent = labels[r.track.automationMode.value] ?? '');
      show();
      state.bind.on(r.track.automationMode, show);
    }
    if (r.entry) {
      const c = r.entry.control;
      const d = q('.val .d');
      const bar = q('.val .meter i');
      const show = () => {
        if (d) d.textContent = c.display.value ?? '';
        if (bar) bar.style.setProperty('--v', `${Math.round((c.normalized.value ?? 0) * 100)}%`);
      };
      show();
      state.bind.on(c.display, show);
      state.bind.on(c.normalized, show);
    }
    ul.appendChild(li);
  }
  paintBrowseMarks();
}

$('filter').onclick = (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  prefs.filter = b.dataset.f;
  savePrefs();
  for (const x of $('filter').children) x.setAttribute('aria-pressed', String(x === b));
  schedule();
};
for (const x of $('filter').children) x.setAttribute('aria-pressed', String(x.dataset.f === prefs.filter));

// ---- Parameter list ------------------------------------------------------------------------
const openGroups = new Set(['Commands']);
const browse = new Luna.Bindings();

function buildBrowse() {
  browse.clear();
  const root = $('groups');
  if (!mapper) return (root.innerHTML = '');
  const q = $('search').value.trim().toLowerCase();
  const hit = (...s) => !q || s.join(' ').toLowerCase().includes(q);
  const groups = new Map();
  groups.set('Commands', AddOnLogic.COMMANDS.filter((c) => hit(c.label, 'command')).map((c) => ({ kind: 'command', key: c.id, label: c.label, sub: 'Command', target: AddOnLogic.commandTarget(c.id) })));
  for (const e of mapper.entries) {
    if (!hit(e.channel, e.area, e.label)) continue;
    if (!groups.has(e.channel)) groups.set(e.channel, []);
    groups.get(e.channel).push({ kind: 'control', key: e.path, label: e.label, sub: e.area, entry: e, target: AddOnLogic.targetOf(e) });
  }
  // Automation modes: per track, under the track (tracks only; LUNA sets modes on tracks).
  for (const track of mapper.session.visibleTracks) {
    const channel = track.name.value ?? track.id;
    for (const action of AddOnLogic.AUTOMATION_ACTIONS) {
      const target = AddOnLogic.automationTarget(track, action);
      if (!hit(channel, target.label, 'automation')) continue;
      if (!groups.has(channel)) groups.set(channel, []);
      groups.get(channel).push({ kind: 'automation', key: autoKey(target), label: target.label, sub: 'Automation', track, action, target });
    }
  }
  // Plugin parameters are not listed up front (reading them all can hang LUNA, fact 101): touch
  // one in the plugin's window while learning and it joins the list.
  for (const ins of mapper.liveInserts()) {
    if (!hit(ins.channel, ins.area, 'plugin')) continue;
    if (!groups.has(ins.channel)) groups.set(ins.channel, []);
    groups.get(ins.channel).push({ kind: 'hint', key: `${ins.channelId}/${ins.slot}`, label: ins.area.replace(/^Insert \d+ · /, ''), sub: `${ins.area.split(' · ')[0]} · touch a knob to learn` });
  }
  $('param-count').textContent = mapper.ready ? String(mapper.entries.length + AddOnLogic.COMMANDS.length) : 'reading…';
  root.innerHTML = '';
  for (const [name, items] of groups) {
    if (!items.length) continue;
    const g = document.createElement('div');
    g.className = 'group';
    g.classList.toggle('open', !!q || openGroups.has(name));
    g.innerHTML = `<button class="gh" aria-expanded="${g.classList.contains('open')}">${esc(name)}<small>${items.length}</small></button><div class="items"></div>`;
    g.querySelector('.gh').onclick = () => {
      openGroups.has(name) ? openGroups.delete(name) : openGroups.add(name);
      g.classList.toggle('open');
    };
    const box = g.querySelector('.items');
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'param';
      b.dataset.key = it.key;
      b.innerHTML = `<span><b>${esc(it.label)}<i class="mapped" hidden></i></b><small>${esc(it.sub)}</small></span><span class="v"></span>`;
      if (it.kind === 'hint') b.classList.add('hint');
      b.onclick = () => {
        if (it.kind === 'hint') {
          if (!mapper.learning) mapper.setLearning(true);
          return;
        }
        if (mapper.pick(it.target) === false) toast(mapper.learnMode === 'mighty' ? 'Click & Turn follows what you click in LUNA; just move a knob' : mapper.learnMode === 'plugin' ? 'Plugin maps take plugin parameters: turn a knob in the plugin’s window' : 'Commands aren’t per track, so they can’t be Channel Focus mappings', true);
      };
      if (it.entry) {
        const v = b.querySelector('.v');
        const show = () => (v.textContent = it.entry.control.display.value ?? '');
        show();
        browse.on(it.entry.control.display, show);
      }
      if (it.kind === 'automation') {
        // The knob and Next show the track's mode; a mode button shows a dot when it's the one.
        const v = b.querySelector('.v');
        const labels = { off: 'Off', read: 'Read', write: 'Write', touch: 'Touch', latch: 'Latch' };
        const show = () => {
          const mode = it.track.automationMode.value;
          v.textContent = it.action === 'knob' || it.action === 'next' ? labels[mode] ?? '' : mode === it.action ? '●' : '';
        };
        show();
        browse.on(it.track.automationMode, show);
      }
      box.appendChild(b);
    }
    root.appendChild(g);
  }
  const err = mapper.lastError;
  $('skipped').hidden = !err;
  $('skipped').textContent = err ? `Could not read that control: ${err.message}` : '';
  paintBrowseMarks();
  paintPicked();
}

const autoKey = (t) => `${t.channelId}#${t.action}`; // a key for an automation target in the list

function paintBrowseMarks() {
  if (!mapper) return;
  const keyOf = (t) => (t.kind === 'command' ? t.command : t.kind === 'automation' && !t.focus ? autoKey(t) : '');
  const mapped = new Set(mapper.rows().map((r) => r.entry?.path ?? keyOf(r.mapping.target)));
  for (const b of document.querySelectorAll('.param')) b.querySelector('.mapped').hidden = !mapped.has(b.dataset.key);
}

function paintPicked() {
  const t = mapper?.pending.target;
  const key = t ? (t.kind === 'command' ? t.command : t.kind === 'automation' ? autoKey(t) : t.path) : undefined;
  if (key === picked) return;
  picked = key;
  for (const b of document.querySelectorAll('.param')) b.classList.toggle('picked', b.dataset.key === key);
}

$('search').oninput = () => buildBrowse();
$('rescan').onclick = () => rescan(true);

let rescanning;
async function rescan(say = false) {
  if (!mapper) return;
  if (rescanning) return rescanning;
  rescanning = (async () => {
    try {
      await mapper.rescan();
      buildBrowse();
      schedule();
      if (say) toast(`${mapper.entries.length} parameters`);
    } catch (e) {
      toast(`Could not read the session: ${e.code ?? e.message}`, true);
    } finally {
      rescanning = undefined;
    }
  })();
  return rescanning;
}

// ---- Learn --------------------------------------------------------------------------------
window.addEventListener(
  'keydown',
  (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'Escape') {
      if (!$('device-menu').hidden) return closeDeviceMenu();
      if (!$('learn-menu').hidden) return closeLearnMenu();
      if (!$('help').hidden) return toggleHelp(false);
      if (colorsEl) return closeColors();
      if (templatesEl) return closeTemplates();
      if (shiftEl) return closeShift();
      if (mapper?.learning) {
        mapper.setLearning(false);
        e.preventDefault();
      }
    } else if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey && mapper) {
      e.preventDefault();
      toggleLearn('map');
    }
  },
  true,
);

// ---- Shift modifier -----------------------------------------------------------------------
let shiftEl = null;
function openShift() {
  if (shiftEl) return closeShift();
  closeColors();
  closeTemplates();
  shiftEl = document.createElement('div');
  shiftEl.className = 'pop shift-pop';
  shiftEl.setAttribute('role', 'dialog');
  shiftEl.setAttribute('aria-label', 'Shift modifier');
  document.body.appendChild(shiftEl);
  paintShift();
}
function closeShift() {
  if (mapper?.learning && mapper.learnMode === 'shift') mapper.setLearning(false);
  shiftEl?.remove();
  shiftEl = null;
}
function paintShift() {
  const pill = $('shift-pill');
  const s = mapper?.shift;
  const active = !!mapper?.shiftActive;
  const learning = !!mapper?.learning && mapper.learnMode === 'shift';
  pill.setAttribute('aria-pressed', String(active));
  const label = s ? `Shift · ${AddOnLogic.sourceLabel(s.source)}` : 'Shift';
  if (pill.textContent !== label) pill.textContent = label;
  if (!shiftEl || !mapper) return;
  const mode = s?.mode ?? 'hold';
  const sig = JSON.stringify([s, active, learning]);
  if (shiftEl.dataset.sig === sig) return;
  shiftEl.dataset.sig = sig;
  shiftEl.innerHTML = `
    <div><h4>Shift modifier</h4><p class="note">Assign a MIDI button as Shift so any other button or knob can have two functions (Normal and Shift). Turn Shift on while learning to map the Shift function.</p></div>
    <div class="s-row"><span>Button</span><span class="s-btn"><b>${esc(s ? AddOnLogic.sourceLabel(s.source) : 'None')}</b><button class="pill learn-pill" id="sh-learn" aria-pressed="${learning}">${learning ? 'Press button…' : s ? 'Relearn' : 'Learn'}</button>${s ? `<button class="x" id="sh-clear" aria-label="Clear Shift button">${X}</button>` : ''}</span></div>
    <div class="s-row"><span>Mode</span><span class="segments" id="sh-mode"><button data-m="hold" aria-pressed="${mode === 'hold'}" title="Shift is active while you hold the button">Hold</button><button data-m="toggle" aria-pressed="${mode === 'toggle'}" title="Press once to turn Shift on, press again to turn it off">Toggle</button></span></div>
    <div class="s-row"><span>Layer</span><button class="switch" id="sh-active" aria-pressed="${active}"><i></i>Shift ${active ? 'on' : 'off'}</button></div>`;
  shiftEl.querySelector('#sh-learn').onclick = () => {
    if (mapper.learning && mapper.learnMode === 'shift') mapper.setLearning(false);
    else mapper.setLearning(true, 'shift');
  };
  if (shiftEl.querySelector('#sh-clear')) shiftEl.querySelector('#sh-clear').onclick = () => mapper.clearShift();
  shiftEl.querySelectorAll('#sh-mode button').forEach((b) => (b.onclick = () => mapper.setShiftMode(b.dataset.m)));
  shiftEl.querySelector('#sh-active').onclick = () => mapper.setShiftActive(!mapper.shiftActive);
}
$('shift-pill').onclick = (e) => {
  e.stopPropagation();
  openShift();
};

// ---- Templates ----------------------------------------------------------------------------
let templatesEl = null;
function openTemplates() {
  if (templatesEl) return closeTemplates();
  closeColors();
  closeShift();
  templatesEl = document.createElement('div');
  templatesEl.className = 'pop templates';
  templatesEl.setAttribute('role', 'dialog');
  templatesEl.setAttribute('aria-label', 'Templates');
  document.body.appendChild(templatesEl);
  paintTemplates();
  templatesEl.querySelector('input')?.focus();
}
function closeTemplates() {
  templatesEl?.remove();
  templatesEl = null;
}
function paintTemplates() {
  if (!templatesEl || !mapper) return;
  const list = mapper.templates();
  const n = mapper.sessionMappings.length;
  // Everything a template would hold, across every section.
  const total = n + mapper.globalMappings.length + mapper.focusMappings.length + (mapper.mighty ? 1 : 0) + mapper.pluginMappings.length;
  const summary = (t) => {
    const parts = [
      [t.mappings?.length ?? 0, 'mapping'],
      [t.globals?.length ?? 0, 'global'],
      [t.focus?.length ?? 0, 'Channel Focus'],
      [t.mighty ? 1 : 0, 'Click & Turn'],
      [t.plugins?.length ?? 0, 'plugin'],
    ].filter(([c]) => c);
    return parts.map(([c, w]) => (w === 'Click & Turn' ? 'Click & Turn' : `${c} ${w}${c === 1 || w === 'Channel Focus' ? '' : 's'}`)).join(' · ') || 'empty';
  };
  templatesEl.innerHTML = `
    <div><h4>Templates</h4><p class="note">A template saves your whole controller layout, every section: this session's mappings, global mappings, Channel Focus, Click &amp; Turn and plugin maps. Load merges it in; Replace clears those sections first.</p></div>
    <div class="save"><input placeholder="Template name" maxlength="60" aria-label="Template name"><button class="pill solid" ${total ? '' : 'disabled'}>Save</button></div>
    ${list.length ? `<ul>${list.map((t, i) => `<li><b>${esc(t.name)}<small>${esc(summary(t))}</small></b><button class="pill" data-apply="${i}">Load</button><button class="pill" data-replace="${i}" title="Clear the sections this template holds, then load it">Replace</button><button class="x" data-del="${i}" aria-label="Delete template">${X}</button></li>`).join('')}</ul>` : '<p class="note">No templates yet.</p>'}
    <div class="foot"><button class="pill" id="t-export">Export…</button><button class="pill" id="t-import">Import…</button><button class="pill danger" id="t-clear" ${n ? '' : 'disabled'}>Clear session</button></div>`;
  const input = templatesEl.querySelector('input');
  const save = () => {
    if (mapper.saveTemplate(input.value)) {
      toast(`Saved template ${input.value.trim()}`);
      paintTemplates();
    }
  };
  templatesEl.querySelector('.save button').onclick = save;
  input.onkeydown = (e) => e.key === 'Enter' && save();
  templatesEl.querySelectorAll('[data-apply],[data-replace]').forEach(
    (b) =>
      (b.onclick = () => {
        const t = list[Number(b.dataset.apply ?? b.dataset.replace)];
        const count = mapper.applyTemplate(t.name, { replace: b.dataset.replace !== undefined });
        const missing = mapper.rows().filter((r) => r.missing).length;
        toast(`Loaded ${count} from ${t.name}${missing ? `; ${missing} not in this session` : ''}`);
        closeTemplates();
      }),
  );
  templatesEl.querySelectorAll('[data-del]').forEach(
    (b) =>
      (b.onclick = () => {
        mapper.deleteTemplate(list[Number(b.dataset.del)].name);
        paintTemplates();
      }),
  );
  templatesEl.querySelector('#t-export').onclick = () => {
    const blob = new Blob([JSON.stringify(mapper.exportAll(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'midi-learn-templates.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  templatesEl.querySelector('#t-import').onclick = () => $('import-file').click();
  templatesEl.querySelector('#t-clear').onclick = () => {
    const n = mapper.sessionMappings.length;
    mapper.clearSession();
    toast(`Cleared ${n} session mapping${n === 1 ? '' : 's'}. Globals stay.`);
    paintTemplates();
  };
}
$('open-templates').onclick = (e) => {
  e.stopPropagation();
  openTemplates();
};
$('import-file').onchange = async () => {
  const file = $('import-file').files?.[0];
  $('import-file').value = '';
  if (!file || !mapper) return;
  try {
    mapper.importAll(JSON.parse(await file.text()));
    toast('Imported templates and global mappings');
    paintTemplates();
  } catch (e) {
    toast(e.message, true);
  }
};

// ---- Background colour (Tik's room picker) --------------------------------------------------
const COLORS = [
  ['tape', '#FFB65A'], ['apricot', '#FFCF8A'], ['rose', '#F2A7A0'], ['lilac', '#C7B8EA'], ['sky', '#9EC5E8'], ['mint', '#A8DCC5'],
  ['sage', '#A1B2A8'], ['olive', '#8E8A6B'], ['chalk', '#F6F6F3'], ['paper', '#E9E9E6'], ['ink', '#2B2B2B'], ['night', '#1C1C1E'],
];
const DEFAULT_COLOR = '#FFB65A';
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/**
 * The activity highlight (a mapping's MIDI pill while it moves): the background's complementary
 * colour, deep on light rooms and bright on dark ones, so it stands out on every background
 * without clashing. A grey room has no hue to complement, so it gets a fixed accent.
 */
function hitColors(hex) {
  const { h, s } = hexToHsv(hex);
  const dark = luminance(hex) < 0.2;
  const hit = s < 0.15 ? (dark ? '#FFC400' : '#2F6BFF') : hsvToHex({ h: (h + 180) % 360, s: dark ? 0.6 : 0.85, v: dark ? 1 : 0.62 });
  return { hit, onHit: luminance(hit) > 0.4 ? '#000' : '#fff' };
}

/** `hex` moved `amount` (0 to 1) of the way toward `to` (a 0-255 channel value). */
function shade(hex, to, amount) {
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + to * amount).toString(16).padStart(2, '0')).join('')}`;
}

function setColor(hex, remember = true) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return false;
  document.documentElement.style.setProperty('--tape', hex);
  // The slightest gradient: a touch lighter at the top, a touch darker at the bottom.
  document.documentElement.style.setProperty('--tape-hi', shade(hex, 255, 0.1));
  document.documentElement.style.setProperty('--tape-lo', shade(hex, 0, 0.12));
  const luna = document.documentElement.dataset.skin === 'luna'; // the LUNA look owns tone and highlight
  const { hit, onHit } = hitColors(hex);
  if (luna) {
    document.documentElement.style.removeProperty('--hit');
    document.documentElement.style.removeProperty('--on-hit');
  } else {
    document.documentElement.style.setProperty('--hit', hit);
    document.documentElement.style.setProperty('--on-hit', onHit);
    document.documentElement.dataset.tone = luminance(hex) < 0.2 ? 'dark' : 'light';
  }
  if (remember) store.set('midilearn.color', hex);
  paintColors();
  return true;
}
let colorsEl = null;
function openColors() {
  // A panel that was detached some other way doesn't count as open: drop it and open afresh.
  if (colorsEl && !colorsEl.isConnected) colorsEl = null;
  if (colorsEl) return closeColors();
  closeTemplates();
  closeShift();
  colorsEl = document.createElement('div');
  colorsEl.className = 'pop colors';
  colorsEl.setAttribute('role', 'dialog');
  colorsEl.setAttribute('aria-label', 'Background colour');
  colorsEl.innerHTML =
    '<h4>Background</h4><div class="grid"></div>' +
    '<label>Custom <button type="button" class="custom" aria-expanded="false" aria-label="Custom colour"></button><button type="button" class="reset">Reset</button></label>' +
    '<div class="picker" hidden><div class="sv" aria-label="Saturation and brightness"><i></i></div><input class="hue" type="range" min="0" max="360" aria-label="Hue"><input class="hex" maxlength="7" spellcheck="false" aria-label="Hex colour"></div>';
  const grid = colorsEl.querySelector('.grid');
  for (const [name, hex] of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = name;
    b.setAttribute('aria-label', name);
    b.style.setProperty('--c', hex);
    b.dataset.hex = hex;
    b.onclick = () => setColor(hex);
    grid.appendChild(b);
  }
  colorsEl.querySelector('.reset').onclick = () => setColor(DEFAULT_COLOR);
  wirePicker(colorsEl);
  colorsEl.prepend(colorsEl.querySelector('h4'), LunaSkin.looksRow());
  document.body.appendChild(colorsEl);
  paintColors();
  (grid.querySelector('[aria-pressed="true"]') ?? grid.firstChild).focus();
}
function closeColors() {
  colorsEl?.remove();
  colorsEl = null;
  for (const stray of document.querySelectorAll('.pop.colors')) stray.remove();
}
function paintColors() {
  const now = getComputedStyle(document.documentElement).getPropertyValue('--tape').trim().toUpperCase();
  if (!colorsEl) return;
  for (const b of colorsEl.querySelectorAll('.grid button')) b.setAttribute('aria-pressed', String(b.dataset.hex.toUpperCase() === now));
  colorsEl.querySelector('.custom').style.setProperty('--c', now || DEFAULT_COLOR);
  colorsEl.paintPicker?.(now);
}
function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`.toUpperCase();
}
// The custom picker lives in the panel: LUNA's webview opens the system colour well far away.
function wirePicker(panel) {
  const picker = panel.querySelector('.picker');
  const sv = picker.querySelector('.sv');
  const thumb = sv.querySelector('i');
  const hue = picker.querySelector('.hue');
  const hex = picker.querySelector('.hex');
  const toggle = panel.querySelector('.custom');
  let hsv = { h: 30, s: 0.65, v: 1 };
  const show = (from) => {
    sv.style.setProperty('--h', hsv.h);
    thumb.style.left = `${hsv.s * 100}%`;
    thumb.style.top = `${(1 - hsv.v) * 100}%`;
    thumb.style.background = hsvToHex(hsv);
    if (from !== 'hue') hue.value = String(Math.round(hsv.h));
    if (from !== 'hex') hex.value = hsvToHex(hsv);
  };
  const apply = (from) => {
    show(from);
    setColor(hsvToHex(hsv));
  };
  panel.paintPicker = (now) => {
    if (/^#[0-9A-F]{6}$/i.test(now) && document.activeElement !== hex) {
      const next = hexToHsv(now);
      if (hsvToHex(next) !== hsvToHex(hsv)) hsv = { ...next, h: next.s === 0 ? hsv.h : next.h };
      show();
    }
  };
  toggle.onclick = () => {
    picker.hidden = !picker.hidden;
    toggle.setAttribute('aria-expanded', String(!picker.hidden));
    if (!picker.hidden) hue.focus();
  };
  const at = (e) => {
    const r = sv.getBoundingClientRect();
    hsv.s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    apply();
  };
  sv.onpointerdown = (e) => {
    sv.setPointerCapture(e.pointerId);
    at(e);
    sv.onpointermove = at;
  };
  sv.onpointerup = sv.onpointercancel = () => (sv.onpointermove = null);
  hue.oninput = () => {
    hsv.h = Number(hue.value);
    apply('hue');
  };
  hex.oninput = () => {
    let v = hex.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) {
      hsv = hexToHsv(v);
      show('hex');
      setColor(v.toUpperCase());
    }
  };
}
$('open-colors').onclick = (e) => {
  e.stopPropagation();
  openColors();
};
document.addEventListener('pointerdown', (e) => {
  if (!$('learn-menu').hidden && !$('learn-menu').contains(e.target)) closeLearnMenu();
  if (!$('device-menu').hidden && !$('device-menu').contains(e.target) && !$('midi-chip').contains(e.target)) closeDeviceMenu();
  if (!$('help').hidden && !$('help').contains(e.target) && e.target !== $('open-help')) toggleHelp(false);
  if (colorsEl && !colorsEl.contains(e.target) && e.target !== $('open-colors')) closeColors();
  if (templatesEl && !templatesEl.contains(e.target) && e.target !== $('open-templates')) closeTemplates();
  if (shiftEl && !shiftEl.contains(e.target) && e.target !== $('shift-pill')) closeShift();
});
setColor(store.get('midilearn.color') ?? DEFAULT_COLOR, false);
// The Look (Default | LUNA) was applied by the early script in index.html; from here it saves through the settings store.
LunaSkin.init({ key: 'midilearn.skin', get: (k) => store.get(k), set: (k, v) => store.set(k, v) });
LunaSkin.onchange = () => setColor(store.get('midilearn.color') ?? DEFAULT_COLOR, false);

// ---- Session ------------------------------------------------------------------------------
// LUNA swaps sessions under the page: closing one empties the list, opening one adds a node that
// is not ready until LUNA has finished loading it, and a request made during the load can time
// out (`get <session>/tracks` did, after 10 s). So bindSession waits for `loaded`, retries
// rather than giving up, and the page rebinds whenever the focused uid differs from the bound one.
let boundId; // the session the page is fully bound to
let bindingId; // the session a bindSession in progress is opening
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showStatus = (html) => {
  $('status').innerHTML = html;
  paintLink();
};
// The dot after the session name: green once LUNA is connected and the session is bound, yellow
// while connecting or opening, red when the connection is down.
function paintLink() {
  const up = luna?.status.value;
  const state = up === 'disconnected' || up === 'closed' ? 'off' : up === 'connected' && mapper ? 'ok' : 'wait';
  const dot = $('link');
  dot.className = `ldot ${state}`;
  dot.title = { ok: 'Connected to LUNA', wait: 'Connecting to LUNA', off: 'LUNA is not connected' }[state];
}

function unbind() {
  for (const u of releases) u();
  releases = [];
  const old = mapper;
  mapper = undefined;
  paintLink();
  boundId = undefined;
  rows.clear();
  for (const l of Object.values(lists)) l.bind.clear();
  mightyBind.clear();
  mightyBound = undefined;
  browse.clear();
  return old?.dispose().catch(() => {});
}

function bindSessionSoon() {
  const want = luna.sessions.current()?.id;
  if (want === bindingId) return; // already on its way
  if (want !== boundId || !mapper) void bindSession();
}

async function bindSession() {
  const gen = ++sessionGen;
  const stale = () => gen !== sessionGen;
  await unbind();
  for (let attempt = 0; ; attempt++) {
    if (stale()) return;
    session = luna.sessions.current();
    bindingId = session?.id;
    if (!session) {
      showStatus('<span>No session open</span>');
      $('maps').innerHTML = '<li class="empty">No session open</li>';
      $('focus-maps').innerHTML = '';
      $('groups').innerHTML = '';
      return; // the focused uid or the list changing calls bindSession again
    }
    showStatus(`<span>Opening${session.name.value ? ` ${esc(session.name.value)}` : ''}…</span>`);
    try {
      // Ask for the session's tracks only once LUNA says it has finished opening it: asked any earlier, LUNA can time the read out.
      await untilLoaded(session, stale);
      if (stale()) return;
      await session.ready();
      if (stale()) return;
      if (session.loaded.value === false) await waitFor(session.loaded, (v) => v === true, stale);
      if (stale()) return;
      await bindReady(session, gen);
      if (!stale()) bindingId = undefined;
      return;
    } catch (e) {
      if (stale()) return;
      report(`bind ${session.id} attempt ${attempt + 1} failed: ${e.code ?? ''} ${e.message}`);
      await unbind();
      await sleep(Math.min(1000 * (attempt + 1), 5000));
    }
  }
}

/** Poll the session node's own `loaded` flag (one small read) until LUNA has opened it. */
async function untilLoaded(s, stale) {
  for (let i = 0; i < 120 && !stale(); i++) {
    try {
      const node = await luna.raw.get(`${s.path}?children=0&commands=0`);
      const loaded = node?.properties?.loaded;
      if (loaded === true || loaded?.value === true || loaded === undefined) return;
    } catch {}
    await sleep(500);
  }
}

/** Resolves when `prop` satisfies `ok`, or when `stale()` turns true. */
function waitFor(prop, ok, stale) {
  return new Promise((resolve) => {
    if (ok(prop.value)) return resolve();
    const stop = prop.onChange(() => {
      if (ok(prop.value) || stale()) {
        stop();
        clearInterval(poll);
        resolve();
      }
    });
    const poll = setInterval(() => {
      if (stale()) {
        stop();
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });
}

async function bindReady(s, gen) {
  const stale = () => gen !== sessionGen;
  const paintName = () => showStatus(`<span class="lbl">SESSION:</span><b>${esc(s.name.value ?? s.uid)}</b>`);
  paintName();
  keep(s.name.onChange(paintName));
  const pluginName = (id) => luna.plugins.byId(id)?.name.value;
  // Mappings saved with the session are read from LUNA first; without them the page falls back to this machine's storage.
  const sessionStore = new AddOnLogic.SessionSettings(s, { onError: (e) => report(`session settings: ${e.code ?? ''} ${e.message}`) });
  await sessionStore.load();
  if (stale()) return;
  const m = new AddOnLogic.Mapper(s, {
    storage: store,
    sessionStore,
    pluginName,
    send: sendMidi,
    subscribe: (p, fn) => luna.raw.subscribe(p, fn, { recursive: true }),
  });
  // Learning and MIDI work as soon as the mappings are read; the scan fills the list after.
  m.loadStored();
  m.onLearnNote = (text) => report(text);
  m.onFocusMoved = (track) => report(`focus → ${track?.name.value ?? 'no track'}; feedback to ${m.focusMappings.filter((x) => x.feedback).length} focus mapping(s)`);
  mapper = m;
  paintLink();
  boundId = s.id;
  keep(m.onChange(schedule));
  let lastCount = -1;
  keep(
    m.onChange(() => {
      if (m.entries.length !== lastCount && m.ready) {
        lastCount = m.entries.length;
        buildBrowse();
      }
    }),
  );
  resetLists(); // a new session's lists appear without animating every row
  buildBrowse();
  schedule();
  const t0 = Date.now();
  await luna.plugins.load().catch(() => {});
  // The strip scan can also hit a session LUNA is still settling; try it a few times.
  for (let attempt = 0; ; attempt++) {
    if (stale()) return;
    try {
      await m.start();
      break;
    } catch (e) {
      report(`scan of "${s.name.value}" attempt ${attempt + 1} failed: ${e.code ?? ''} ${e.message}`);
      if (attempt >= 4) {
        toast(`Could not read the session: ${e.code ?? e.message}`, true);
        return;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  if (stale()) return;
  report(`session "${s.name.value}" (${s.sessionPackageUid.value}): ${m.entries.length} controls, ${m.liveInserts().length} plugins, ${m.all().length} mappings, ${Date.now() - t0} ms`);
  // Tracks, buses and inserts change: read the controls again, once things settle.
  let t;
  const soon = () => {
    clearTimeout(t);
    t = setTimeout(() => void rescan(), 600);
  };
  keep(() => clearTimeout(t));
  keep(s.tracks.onChange(soon));
  keep(s.buses.onChange(soon));
  for (const ch of [...s.visibleTracks, ...s.buses.items]) {
    keep(ch.effects.onChange(soon));
    keep(ch.name.onChange(soon));
    // Loading a plugin into a slot changes that slot's plugin, not the list of slots.
    for (const fx of ch.effects.items) keep(fx.pluginId.onChange(soon));
  }
}

// ?demo runs on an in-page Luna.MockEngine with a made-up session, to try the page without LUNA.
function demoEngine() {
  const engine = new Luna.MockEngine();
  engine.addSession('demo', { name: 'Demo Session', tracks: ['Lead Vocal', 'Bass', 'Keys', 'Drums'] });
  engine.addPlugin('com.uaudio.uadx.1176', { name: 'UA 1176', categories: ['Compressor'] });
  return engine;
}

async function connect() {
  const demo = new URLSearchParams(location.search).has('demo') ? demoEngine() : undefined;
  globalThis.midiLearn.demo = demo;
  for (;;) {
    try {
      luna = await Luna.connect(demo ? { port_: demo.port() } : undefined);
      if (demo) {
        const s = await luna.session();
        await s.visibleTracks[0].insert('com.uaudio.uadx.1176');
      }
      break;
    } catch (e) {
      $('status').innerHTML = `<span>${e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : esc(e.message)}</span>`;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  startMidi();
  paintLink();
  luna.status.onChange(paintLink);
  await luna.sessions.ready();
  // The focused uid, the list and the connection all decide which session to show.
  luna.sessions.focusedUid.onChange(bindSessionSoon);
  luna.sessions.items.onChange(bindSessionSoon);
  luna.status.onChange(() => luna.status.value === 'connected' && bindSessionSoon());
  await bindSession();
}

// ---- Staying healthy over hours ------------------------------------------------------------
// LUNA keeps this page loaded for hours, through engine reconnects and the window
// being hidden. Every 30 s, check what should always hold, repair it, and log anything that
// was wrong, so a slow failure can be traced.
function healthSnapshot() {
  const sw = $('open-colors').getBoundingClientRect();
  const atSwatch = document.elementFromPoint(sw.left + sw.width / 2, sw.top + sw.height / 2);
  return {
    build: BUILD,
    uptimeMin: Math.round(performance.now() / 60000),
    tape: getComputedStyle(document.documentElement).getPropertyValue('--tape').trim(),
    colorsOpen: !!colorsEl,
    colorsAttached: colorsEl ? colorsEl.isConnected : null,
    colorPanels: document.querySelectorAll('.pop.colors').length,
    templatesOpen: !!templatesEl,
    learnMenuOpen: !$('learn-menu').hidden,
    swatch: { top: Math.round(sw.top), left: Math.round(sw.left), w: Math.round(sw.width), visible: sw.width > 0 && sw.top >= 0 && sw.left < innerWidth },
    atSwatch: atSwatch ? `${atSwatch.tagName.toLowerCase()}#${atSwatch.id}.${[...atSwatch.classList].join('.')}` : null,
    scroll: { html: document.documentElement.scrollTop, body: document.body.scrollTop },
    viewport: [innerWidth, innerHeight],
    focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}#${document.activeElement.id}` : null,
    luna: luna?.status.value,
    midi: midiIn.via,
    midiInputs: midiIn.inputs.length,
    session: session?.name.value,
    mapper: !!mapper,
    learning: mapper?.learning ?? false,
    rows: mapper?.all().length,
    dom: document.getElementsByTagName('*').length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : undefined,
  };
}

function healthCheck() {
  const problems = [];
  // The page itself never scrolls (only the board does); a focus() can scroll it in WebKit.
  if (document.documentElement.scrollTop || document.body.scrollTop) {
    problems.push(`page scrolled (${document.documentElement.scrollTop}/${document.body.scrollTop})`);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }
  if (colorsEl && !colorsEl.isConnected) {
    problems.push('colour panel detached');
    colorsEl = null;
  }
  const panels = document.querySelectorAll('.pop.colors');
  if (panels.length > (colorsEl ? 1 : 0)) {
    problems.push(`${panels.length} colour panels`);
    for (const p of panels) if (p !== colorsEl) p.remove();
  }
  const snap = healthSnapshot();
  if (snap.atSwatch && !snap.atSwatch.startsWith('button#open-colors')) problems.push(`colour button covered by ${snap.atSwatch}`);
  if (!snap.swatch.visible) problems.push('colour button off screen');
  if (problems.length) report(`health: ${problems.join('; ')} | ${JSON.stringify(snap)}`);
}
setInterval(healthCheck, 30000);

renderDevices();
connect();
