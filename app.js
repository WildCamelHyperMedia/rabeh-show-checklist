/*
 * RABEH weekly show checklist — the page (rendering + local-first sync).
 *
 * The DOM is built once from the template (checklist.js); after that only single nodes are patched when
 * the state changes, so nothing the producer is typing in is ever re-rendered and the focus never moves.
 *
 * Every user action goes through RabehCore.applyAction, is written to localStorage at once and is then
 * sent to the Google Sheet through the Apps Script web app (SPEC §4):
 *   localStorage "rabeh.show.<date>" = { state, dirty: { fieldId: u }, rev, pre }
 *   localStorage "rabeh.settings"    = { code, device, endpoint, connected, offset }
 *   localStorage "rabeh.cache"       = { roster, defaults, sheetName, sheetUrl, build }
 *   localStorage "rabeh.last"        = { fieldId: [{ v, d }] } values remembered for later shows
 *   sessionStorage "rabeh.tab"       = { date, manual, at, link, reloaded, moved } the show this tab has open
 *                                      (survives a reload), and when the page last reloaded itself for a new week
 *
 * Classic script, ES2019 at most, no dependencies. Whatever comes from the Sheet or from the user reaches
 * the DOM through textContent / value only. The access code lives in localStorage and in request bodies —
 * never in a URL, never in the console.
 */
(function () {
  "use strict";

  const core = window.RabehCore;
  const template = window.RABEH_TEMPLATE;
  const config = window.RABEH_CONFIG || {};
  const main = document.getElementById("sections");
  if (!main) return;
  if (!core || !template) {
    const fatal = document.createElement("p");
    fatal.className = "fatal";
    fatal.textContent = "The checklist could not start: a file is missing. Check the connection and reload the page.";
    main.appendChild(fatal);
    return;
  }

  /* ------------------------------------------------------------------ constants */

  const KEY = { settings: "rabeh.settings", cache: "rabeh.cache", last: "rabeh.last", show: "rabeh.show.", tab: "rabeh.tab" };

  const TYPING_DEBOUNCE_MS = 400;   // text being typed -> state
  const SAVE_DEBOUNCE_MS = 900;     // last change -> save request
  const BUSY_RETRY_MS = 3000;       // the Sheet answered "busy"
  const BACKOFF_MS = [5000, 15000, 30000, 60000];
  const REQUEST_TIMEOUT_MS = 45000; // a save may wait 20 s for the Sheet's lock before it even starts
  const DRIVE_HICCUP_RETRY_MS = [1500, 3000]; // Google now and then answers one web-app request with its "unable to open the file" page (HTTP 404); the next request goes through
  const KEEPALIVE_MAX_BYTES = 60000; // browsers allow 64 KiB of keepalive bodies in flight at a time; stay below
  const MAX_SAVE_TRIES = 3;         // failed saves of a show that is not open, before it waits for the next reconnect
  const HOLD_RELEASE_MS = 5000;     // an auto stamp held back while its text is typed is released after this pause
  const AUTOFILL_MS = 800;          // a time that appears this soon after an empty time field opened was not typed
  const UNDO_MS = 7000;             // how long "Undo" stays on screen
  const DOUBLE_TAP_MS = 700;        // a second tap on the final status this soon is a double tap, not "clear"
  const CONFIRM_MS = 4000;          // "tap again to disconnect"
  const CLOCK_WARN_MS = 30 * 60 * 1000; // device clock this far from the Sheet's: its clock or time zone is wrong
  const HELLO_EVERY_MS = 10 * 60 * 1000;
  const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
  const KEEP_SHOWS = 80;            // shows kept on the device (unsaved ones are never dropped)
  const HISTORY_LIMIT = 60;         // shows asked from the Sheet for the History list
  const REMEMBER_SHOWS = 6;         // per "same as last week" field: values of this many recent shows
  const MAX_NAME = 80;
  // The Sheet creates no show dated before FIRST_SHOW or more than about a year ahead (a slip of the year
  // in the date picker); the picker and the week arrows stay inside the same range.
  const FIRST_SHOW = "2020-01-01";
  const DAYS_AHEAD = 365;
  // "By" of a value the page itself brought in line with the Sheet's Crew / Settings tab (adoptSheetDefaults).
  // Such a value is nobody's typing: it keeps following those tabs, and the Sheet shows where it came from.
  const SHEET_BY = "Crew / Settings tab";

  // The only addresses a save may go to (SPEC §4). Never taken from the page URL.
  const ENDPOINT_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
  const LOCAL_ENDPOINT_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?(\/\S*)?$/;
  const SHEET_URL_RE = /^https:\/\/docs\.google\.com\//;

  // Short names for the section chips; a section added to the template later falls back to its title.
  const SHORT_TITLES = {
    gfx: "Graphics", crew: "Crew", cam: "Cameras", sw: "Switching", aud: "Audio", em1: "Emcee 1",
    em2: "Emcee 2", rec: "Recording", fin: "Readiness", iss: "Issues", post: "Post-show"
  };

  // The final status as the sticky bar repeats it (it has to fit under the date on a phone); an option added to
  // the template later falls back to its label. Until one is chosen the bar says so, as a to-do tag.
  const SHORT_STATUS = { ready: "Ready", ready_issue: "Ready · issue", not_ready: "Not ready" };
  const NO_STATUS = "No status";

  // `text` must fit the bar of a 320 px phone next to the date (19 characters); `extra` shows from 620 px.
  const PILL = {
    local: { text: "On this device only", extra: "", tone: "mute" },
    needcode: { text: "Access code needed", extra: "", tone: "bad" },
    connecting: { text: "Connecting…", extra: "", tone: "busy" },
    saving: { text: "Saving…", extra: "", tone: "busy" },
    ok: { text: "Saved to sheet", extra: "", tone: "good" },
    // No network at all.
    offline: { text: "Offline · on device", extra: "", tone: "warn", say: "Offline. Changes are kept on this device." },
    // The network is there, but the request got no answer.
    unreachable: { text: "Can't reach Sheet", extra: " · kept on device", tone: "warn", say: "Cannot reach the Sheet. Changes are kept on this device." },
    // Something answered, but the Sheet did not take the changes (error page, script error, refused save).
    trouble: { text: "Sheet not saving", extra: " · kept on device", tone: "bad", say: "The Sheet is not saving. Changes are kept on this device." },
    // The open show is saved; an earlier one still has changes that only this device holds.
    behind: { text: "Past show not saved", extra: " · see History", tone: "warn" },
    // Not reaching the Sheet AND the browser refuses to store: nothing would survive a reload.
    unsafe: { text: "Not saved anywhere", extra: " · keep this page open", tone: "bad", say: "Warning. Changes are not being saved anywhere. Keep this page open." }
  };

  /* ------------------------------------------------------------------ small helpers */

  const hasOwn = Object.prototype.hasOwnProperty;
  const own = (obj, key) => (obj != null && hasOwn.call(obj, key) ? obj[key] : undefined);
  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const str = (x) => (typeof x === "string" ? x : "");
  const oneLine = (x, max) => str(x).replace(/\s+/g, " ").trim().slice(0, max);
  const $ = (id) => document.getElementById(id);
  const stampOf = (value) => (isObj(value) && isNum(value.u) && value.u > 0 ? value.u : 0);

  // el("div", { class: "row", text: "…", hidden: true }, [children]) — attributes only, text via textContent.
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((name) => {
        const value = attrs[name];
        if (value == null || value === false) return;
        if (name === "text") node.textContent = value;
        else if (name === "class") node.className = value;
        else node.setAttribute(name, value === true ? "" : value);
      });
    }
    (children || []).forEach((child) => {
      if (child) node.appendChild(child);
    });
    return node;
  }

  const store = {
    read(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? null : JSON.parse(raw);
      } catch (err) {
        return null;
      }
    },
    write(key, value) {
      const text = JSON.stringify(value);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          localStorage.setItem(key, text);
          storageState(false);
          return true;
        } catch (err) {
          // Full? The shows the Sheet already holds can go; then one more try.
          if (attempt || !dropSavedShows(key)) break;
        }
      }
      storageState(true);
      return false;
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (err) {
        // nothing was stored, nothing to remove
      }
    },
    keys(prefix) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.indexOf(prefix) === 0) out.push(key);
        }
      } catch (err) {
        // storage unavailable: behave as if it were empty
      }
      return out;
    }
  };

  // What this tab has open, kept for the tab only (a phone that discards a background tab reloads it later).
  const tabMemory = {
    read() {
      try {
        const value = JSON.parse(sessionStorage.getItem(KEY.tab));
        return isObj(value) ? value : {};
      } catch (err) {
        return {};
      }
    },
    write(value) {
      try {
        sessionStorage.setItem(KEY.tab, JSON.stringify(value));
      } catch (err) {
        // not kept: after a reload the page opens on its default show
      }
    },
    clear() {
      try {
        sessionStorage.removeItem(KEY.tab);
      } catch (err) {
        // nothing was kept
      }
    }
  };

  let storageBroken = false; // the last write did not get through: what is typed now would not survive a reload
  let storageWarned = false;

  function storageState(broken) {
    if (storageBroken === broken) return;
    storageBroken = broken;
    if (broken && !storageWarned) {
      storageWarned = true;
      toast("This browser is not keeping changes on the device. Stay online until everything shows as saved.", "bad");
    }
    setTimeout(renderStatus, 0); // the pill and the banner say so for as long as it lasts
  }

  // Storage is full: stored shows with nothing unsaved (the Sheet has them) make room. Never the open show
  // or the entry being written. Returns whether anything was removed.
  function dropSavedShows(keepKey) {
    let removed = false;
    storedDates().forEach((date) => {
      const key = KEY.show + date;
      if (key === keepKey || (show && show.date === date) || hasDirty(readRecord(date))) return;
      store.remove(key);
      removed = true;
    });
    return removed;
  }

  /* ------------------------------------------------------------------ settings, clock, device */

  const readObject = (key) => {
    const value = store.read(key);
    return isObj(value) ? value : {};
  };

  let settings = readObject(KEY.settings);
  const cache = readObject(KEY.cache);
  const last = readObject(KEY.last);
  if (!isObj(cache.roster)) cache.roster = {};
  if (!isObj(cache.defaults)) cache.defaults = {};

  const saveSettings = () => store.write(KEY.settings, settings);
  const saveCache = () => store.write(KEY.cache, cache);

  function validEndpoint(url) {
    const s = str(url).trim();
    return ENDPOINT_RE.test(s) || LOCAL_ENDPOINT_RE.test(s) ? s : "";
  }
  const fixedEndpoint = validEndpoint(config.endpoint); // from config.js; wins over the Settings dialog
  const endpoint = () => fixedEndpoint || validEndpoint(settings.endpoint);
  const canSync = () => !!endpoint() && settings.connected === true;

  // Server-aligned clock: every reply carries the Sheet's time, and all stamps are taken from it.
  let storedOffset = isNum(settings.offset) ? settings.offset : 0;
  const now = () => Date.now() + (isNum(settings.offset) ? settings.offset : 0);
  function noteServerTime(serverNow) {
    settings.offset = Math.round(serverNow - Date.now());
    if (Math.abs(settings.offset - storedOffset) > 500) { // do not rewrite storage for network jitter
      storedOffset = settings.offset;
      saveSettings();
    }
  }
  const clock = () => {
    const t = now();
    return { now: t, hm: core.hmFromMs(t), by: deviceName() };
  };
  // Stamps are the Sheet's instant shown on this device's wall clock. A device whose clock is far from the
  // Sheet's (set by hand, or set to look right in the wrong time zone) records wrong times: say so.
  function clockOff() {
    const off = settings.connected === true && isNum(settings.offset) ? Math.abs(settings.offset) : 0;
    if (off <= CLOCK_WARN_MS) return "";
    const minutes = Math.round(off / 60000);
    return minutes < 90 ? minutes + " minutes" : Math.round(minutes / 6) / 10 + " hours";
  }

  // A device label, never a person's name (it is written next to every change in the Sheet).
  function guessDevice() {
    const ua = navigator.userAgent || "";
    const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1; // an iPad calls itself a Mac
    if (/iPad|Tablet/i.test(ua) || touchMac || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "Producer tablet";
    if (/iPhone|iPod|Mobile/i.test(ua)) return "Producer phone";
    return "Producer laptop";
  }
  const deviceName = () => oneLine(settings.device, core.MAX_BY) || guessDevice();

  // iPhone / iPad (an iPad calls itself a Mac). Every browser there is WebKit underneath.
  const touchApple = (() => {
    const ua = navigator.userAgent || "";
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  })();
  // …showing the page in a Safari tab: Safari deletes a site's storage (access code, offline copy, unsent
  // changes) after seven days without a visit. The Home Screen app is exempt and has its own storage.
  const safariTab = touchApple && navigator.standalone === false;

  /* ------------------------------------------------------------------ show records */

  const defs = core.fieldById(template);
  // source field -> time fields stamped when it first gets content (the issue "flagged at" rule)
  const stampTargets = Object.create(null);
  core.flatten(template).forEach((def) => {
    if (def.type !== "time" || !def.stampWhenFilled) return;
    (stampTargets[def.stampWhenFilled] = stampTargets[def.stampWhenFilled] || []).push(def.id);
  });

  let show = null;          // the open show: { date, state, dirty, rev, pre }
  let autoDate = true;      // the date was chosen by the page, not by the producer
  let lastLocalChange = 0;  // device time of the last change made here
  let lastTouch = Date.now(); // device time of the last sign of somebody using the page (tap, key, scroll, opening a show)
  let tabLink = "";         // the ?date= this tab was opened with ("" = none)
  let offWeek = false;      // the open show is neither this week's nor the one being finished (as of the last renderDate)
  let offWeekTold = "";     // the show date the "not this week's show" reminder was last shown for
  let lastReload = 0;       // device time at which this tab last reloaded itself for a new week (0 = never)

  // The show the page opens by itself: this week's, or last Friday's while its post-show checks are open.
  const defaultShowDate = () => core.defaultShowDate(new Date(), template, (date) => recordFor(date).state);

  // `pre` lists the prefilled (u = 0) fields the Sheet already holds; it owns those from then on.
  function readRecord(date) {
    const rec = { date: date, state: {}, dirty: {}, rev: 0, pre: {} };
    const raw = store.read(KEY.show + date);
    if (!isObj(raw)) return rec;
    if (isObj(raw.state)) rec.state = Object.assign({}, core.merge({}, raw.state).state); // re-validated copy
    if (isObj(raw.dirty)) {
      Object.keys(raw.dirty).forEach((id) => {
        if (own(rec.state, id) && isNum(raw.dirty[id])) rec.dirty[id] = raw.dirty[id];
      });
    }
    if (isNum(raw.rev) && raw.rev > 0) rec.rev = raw.rev;
    if (isObj(raw.pre)) {
      Object.keys(raw.pre).forEach((id) => {
        rec.pre[id] = 1;
      });
    }
    return rec;
  }

  const hasDirty = (rec) => Object.keys(rec.dirty).length > 0;

  // A show that was only looked at (prefills, nothing typed, unknown to the Sheet) is not worth keeping.
  function worthKeeping(rec) {
    if (rec.rev > 0 || hasDirty(rec)) return true;
    return Object.keys(rec.state).some((id) => stampOf(rec.state[id]) > 0);
  }

  function writeRecord(rec) {
    if (!worthKeeping(rec)) {
      store.remove(KEY.show + rec.date);
      return;
    }
    store.write(KEY.show + rec.date, { state: rec.state, dirty: rec.dirty, rev: rec.rev, pre: rec.pre });
  }

  // The live object for the open show, a fresh copy from storage for any other date.
  const recordFor = (date) => (show && show.date === date ? show : readRecord(date));

  function storedDates() {
    return store.keys(KEY.show)
      .map((key) => key.slice(KEY.show.length))
      .filter((date) => core.isValidDate(date))
      .sort()
      .reverse();
  }

  function pruneStoredShows() {
    storedDates().slice(KEEP_SHOWS).forEach((date) => {
      if (!hasDirty(readRecord(date))) store.remove(KEY.show + date);
    });
  }

  /* ------------------------------------------------------------------ prefills and remembered values */

  /*
   * The "same as last week" fields (location, live time, call time, emcees…). Per field the device keeps
   * the values of its most recent shows, newest first: [{ v, d: showDate }]. A show is prefilled from the
   * latest show BEFORE it, so preparing next week's show early never leaks into this week's.
   */
  const rememberedList = (id) => (Array.isArray(last[id]) ? last[id].filter((e) => isObj(e) && typeof e.v === "string" && core.isValidDate(e.d)) : []);

  function lastValuesFor(date) {
    const out = {};
    Object.keys(last).forEach((id) => {
      const earlier = rememberedList(id).filter((entry) => entry.d < date)[0];
      if (earlier) out[id] = earlier.v;
    });
    return out;
  }

  function noteRemembered(rec, ids) {
    let touched = false;
    ids.forEach((id) => {
      const def = defs[id];
      if (!def || !def.remember) return;
      const list = rememberedList(id).filter((entry) => entry.d !== rec.date);
      const value = core.valueOf(def, rec.state).v.trim();
      if (value) list.push({ v: value, d: rec.date });
      list.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
      last[id] = list.slice(0, REMEMBER_SHOWS);
      touched = true;
    });
    if (touched) store.write(KEY.last, last);
  }

  /*
   * (Re)fill the prefilled fields from the roster, the Sheet's defaults and the remembered values.
   * Only fields nobody has touched (absent or u = 0) are filled, never one the Sheet already holds
   * (`pre`), and never the one being typed in. Returns the ids that changed.
   */
  function refillPrefills(rec, skip) {
    const wanted = core.defaultsFor(template, cache.roster, cache.defaults, lastValuesFor(rec.date));
    const ids = Object.keys(wanted);
    Object.keys(rec.state).forEach((id) => {
      if (stampOf(rec.state[id]) === 0 && ids.indexOf(id) === -1) ids.push(id);
    });
    const changed = [];
    let next = null;
    ids.forEach((id) => {
      const current = own(rec.state, id);
      if (own(rec.pre, id) || (skip && skip.indexOf(id) !== -1)) return;
      if (current && stampOf(current) > 0) return;
      const want = own(wanted, id);
      if (want ? current && current.v === want.v : !current) return;
      next = next || Object.assign({}, rec.state);
      if (want) next[id] = want;
      else delete next[id];
      changed.push(id);
    });
    if (next) rec.state = next;
    return changed;
  }

  /* ------------------------------------------------------------------ building the page (once) */

  const dom = {};
  [
    "banner", "banner-notes", "banner-connect", "print-date", "date-note", "date-text", "date-input", "prev-week", "next-week",
    "this-week", "hdr-fields", "overall", "overall-num", "overall-meter", "overall-bar", "overall-secs", "bar", "bar-date", "bar-status", "bar-count",
    "sync-pill", "pill-text", "pill-extra", "chips", "open-history", "open-sheet", "open-settings", "print",
    "dlg-connect", "connect-form", "connect-title", "conn-status", "conn-text", "conn-build", "in-code", "in-device", "adv",
    "in-endpoint", "connect-msg", "endpoint-msg", "home-hint", "btn-disconnect", "btn-erase", "btn-connect",
    "dlg-history", "history-note", "history-list", "live", "toasts"
  ].forEach((id) => {
    dom[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = $(id);
  });

  const fields = Object.create(null); // fieldId -> { def, commit(final), update() }
  const sectionsUI = [];              // { key, node, count, chip, chipCount, slots }
  const issueSlots = [];              // { slot, node, group, tag }
  const statusTags = Object.create(null); // choice field id -> the tag in the head of its section
  const rosterLabels = [];            // texts that depend on the crew names: { label, fallback, apply(text) }
  let addIssueWrap = null;
  let issueReveal = 1;                // issue slots opened with "+ Add another issue" (per show)

  const domId = (def, part) => "f-" + def.id + (part ? "-" + part : "");

  /*
   * The names in the labels of the open show ("Camera switching tested with …"): the Sheet's roster, or
   * the stand-in typed into that role's name field for this show (core.rosterFor). null until a show is open.
   */
  let names = null;
  const nameKeys = Object.create(null); // name field id -> role key
  core.flatten(template).forEach((def) => {
    const found = def.type === "text" ? /^roster\.([A-Za-z0-9_]+)$/.exec(str(def.default)) : null;
    if (found) nameKeys[def.id] = found[1];
  });
  const sameNames = (a, b) => Object.keys(template.roles || {}).every((key) => oneLine(own(a, key), MAX_NAME) === oneLine(own(b, key), MAX_NAME));

  // The fields prefilled from the Sheet's Crew / Settings tabs alone (not "same as last week" ones), and for
  // a crew member's name the "Present" box of the same member.
  const sheetDefaultIds = [];
  const presentOf = Object.create(null); // name field id -> id of that member's "Present" check
  core.flatten(template).forEach((def) => {
    const fromSheet = /^(roster|defaults)\.[A-Za-z0-9_]+$/.test(str(def.default)) && (def.type === "text" || def.type === "time");
    if (fromSheet && !def.remember) sheetDefaultIds.push(def.id);
    if (def.type !== "check" || !def.role) return;
    Object.keys(nameKeys).forEach((nameId) => {
      if (defs[nameId].role === def.role) presentOf[nameId] = def.id;
    });
  });

  // A text that depends on the crew names: set now, and again whenever the names change.
  function onLabel(label, fallback, apply) {
    rosterLabels.push({ label: label, fallback: fallback, apply: apply });
    apply(core.resolveLabel(label, names || cache.roster, fallback));
  }

  function rosterLabel(node, label, fallback) {
    onLabel(label, fallback, (text) => {
      node.textContent = text;
    });
    return node;
  }

  function relabel() {
    rosterLabels.forEach((item) => item.apply(core.resolveLabel(item.label, names || cache.roster, item.fallback)));
  }

  // Works out the names again after the roster, the show or a name field changed. A name still being typed
  // keeps its old label until the field is left ("S", "Sa", "Sam" must not flicker through every label).
  function refreshNames() {
    if (!show) return;
    const next = core.rosterFor(template, cache.roster, show.state);
    const key = nameKeys[typingId()];
    if (key && names) next[key] = str(own(names, key));
    if (names && JSON.stringify(next) === JSON.stringify(names)) return;
    names = next;
    relabel();
  }

  /*
   * "Being edited" = the input has the focus AND so does the window. When the window, tab or app loses the
   * focus the element stays document.activeElement (and gets change + blur), but nobody is typing there.
   */
  const pageFocused = () => typeof document.hasFocus !== "function" || document.hasFocus();
  const editing = (input) => document.activeElement === input && pageFocused();

  // Never touch an input that is being edited: the producer's typing wins until the field is left.
  // `force` is for the moment the field has just been finished (see releaseDeferred).
  function setInput(input, value, force) {
    if (!force && editing(input)) return;
    // badInput = a half-typed time left behind: writing the value again wipes it from the display.
    if (input.value !== value || (input.validity && input.validity.badInput)) input.value = value;
  }

  // A time input; `.empty` lets the stylesheet draw one dash in every browser (see style.css).
  function setTimeInput(input, value, force) {
    setInput(input, value, force);
    input.classList.toggle("empty", !value);
  }

  function grow(area) {
    area.style.height = "auto";
    const height = area.scrollHeight;
    area.style.height = height > 0 ? height + 2 + "px" : ""; // 0 = inside a hidden block; sized when shown
  }

  function growAll(root) {
    (root || document).querySelectorAll("textarea.in").forEach(grow);
  }

  // Wires an input the producer types in: state follows after a pause, and at once when the field is left.
  function bindTyping(input, id) {
    input.dataset.field = id;
    input.addEventListener("input", () => scheduleCommit(id));
    input.addEventListener("change", () => finishEditing(id));
    input.addEventListener("blur", () => finishEditing(id));
  }

  /*
   * A time input: its "change" fires while the picker is still open, so it only schedules a commit.
   *
   * iPhone / iPad put the current time into an EMPTY time field the moment its wheel opens, before anything
   * was chosen. Taken at face value, one exploratory tap on an arrival box would mark that person present.
   * So there, a value that shows up within AUTOFILL_MS of an empty field getting the focus, and equals the
   * time on the device's clock, is not stored; it counts only once the producer changes it. If the field is
   * left untouched it is emptied again ("now" stays one tap away through the tick and the NOW buttons).
   * Elsewhere a time only arrives when somebody chose it (Android: "OK" in the clock dialog), so it is kept.
   */
  function bindTimeInput(input, id) {
    input.dataset.field = id;
    let opened = 0;      // when the field got the focus while empty
    let untouched = "";  // the time the browser put in by itself, for as long as it has not been changed
    const deviceTime = (ms) => core.hmFromMs(ms);
    const typed = () => {
      if (untouched && input.value === untouched) return; // input + change both report the same insert
      const sudden = touchApple && opened > 0 && Date.now() - opened < AUTOFILL_MS;
      const value = core.normHM(input.value);
      opened = 0;
      untouched = "";
      if (sudden && value && (value === deviceTime(Date.now()) || value === deviceTime(Date.now() - AUTOFILL_MS))) {
        untouched = input.value;
        return;
      }
      scheduleCommit(id);
    };
    input.addEventListener("focus", () => {
      opened = input.value ? 0 : Date.now();
      untouched = "";
    });
    input.addEventListener("input", typed);
    input.addEventListener("change", typed);
    input.addEventListener("blur", () => {
      if (untouched && input.value === untouched) input.value = "";
      opened = 0;
      untouched = "";
      finishEditing(id);
    });
  }

  // Returns true when the time shown was edited by hand (the stylesheet then marks it "Edited", in amber).
  function timeNote(shown, autoNode, pvNode, def, value) {
    pvNode.textContent = core.to12h(shown);
    const edited = core.isEdited(def, value);
    autoNode.textContent = edited ? "Auto " + core.to12h(value.a) : "";
    autoNode.hidden = !edited;
    return edited;
  }

  // opts.block: the crew block this check belongs to; it is marked while the box is ticked.
  function buildCheck(def, opts) {
    const block = opts && opts.block;
    const box = el("input", { type: "checkbox", id: domId(def) });
    const text = rosterLabel(el("span", { class: "lbl", id: domId(def, "l") }), def.label, def.fallback);
    const cap = el("span", { class: def.timeLabel ? "cap mono" : "cap sr-only", id: domId(def, "c"), text: def.timeLabel || "Time" });
    const time = el("input", { type: "time", class: "time empty", id: domId(def, "t") });
    // Named for screen readers: "Time — Script checked"; the six crew rows by their role, "Arrival time — vMix Operator".
    onLabel(def.role ? def.groupLabel : def.label, def.role ? def.groupFallback : def.fallback, (name) => {
      time.setAttribute("aria-label", (def.timeLabel || "Time") + " — " + name);
    });
    const pv = el("span", { class: "pv" });
    const auto = el("span", { class: "auto mono", hidden: true });
    const stamp = el("div", { class: "stamp" }, [cap, time, pv]);
    const tick = el("label", { class: "tick", for: domId(def) }, [box, el("span", { class: "box", "aria-hidden": "true" }), text]);
    // The "Edited · Auto 7:13 PM" note takes a line of its own under the row: the time box is too narrow for it.
    const row = el("div", { class: "row check" }, [tick, stamp, auto]);

    box.addEventListener("change", () => act({ type: "toggle", id: def.id, on: box.checked }));
    // The strip beside the label (where the time will appear) ticks too; it never unticks.
    row.addEventListener("click", (event) => {
      if ((event.target === row || event.target === stamp) && !box.checked) act({ type: "toggle", id: def.id, on: true });
    });
    bindTimeInput(time, def.id);

    fields[def.id] = {
      def: def,
      commit() {
        if (time.validity && time.validity.badInput) return; // half-typed time: wait for the rest
        act({ type: "setTime", id: def.id, value: time.value });
      },
      update(force) {
        const value = core.valueOf(def, show.state);
        const on = value.v === 1;
        box.checked = on;
        row.classList.toggle("on", on);
        if (block) block.classList.toggle("on", on);
        if (!def.timeAlways) {
          stamp.classList.toggle("off", !on);
          time.disabled = !on;
        }
        setTimeInput(time, value.t, force);
        stamp.classList.toggle("edited", timeNote(value.t, auto, pv, def, value));
      }
    };
    return row;
  }

  function buildTime(def, opts) {
    const stacked = !!(opts && opts.stacked);
    const label = rosterLabel(el("label", { class: stacked ? "mono" : "lbl", for: domId(def), id: domId(def, "l") }), def.label, def.fallback);
    const input = el("input", { type: "time", class: "time empty", id: domId(def) });
    const pv = el("span", { class: "pv" });
    const auto = el("span", { class: "auto mono", hidden: true });
    let nowBtn = null;
    if (def.now) {
      nowBtn = el("button", { type: "button", class: "now", text: "Now", "aria-describedby": domId(def, "l") });
      nowBtn.addEventListener("click", () => act({ type: "stampNow", id: def.id }));
    }
    const stamp = el("div", { class: "stamp" }, [el("div", { class: "ctl" }, [input, pv, nowBtn]), auto]);
    const row = el("div", { class: "row time" + (stacked ? " stacked" : "") }, [label, stamp]);
    bindTimeInput(input, def.id);

    fields[def.id] = {
      def: def,
      commit() {
        if (input.validity && input.validity.badInput) return;
        act({ type: "setTime", id: def.id, value: input.value });
      },
      update(force) {
        const value = core.valueOf(def, show.state);
        setTimeInput(input, value.v, force);
        stamp.classList.toggle("edited", timeNote(value.v, auto, pv, def, value));
      }
    };
    return row;
  }

  // opts.quiet: the visible caption comes from the surrounding block (crew role), the label stays for screen readers.
  function buildText(def, opts) {
    const quiet = !!(opts && opts.quiet);
    const notes = def.type === "notes";
    const isName = /\.name$/.test(def.id) || def.id === "hdr.producer";
    const label = rosterLabel(el("label", { class: quiet ? "sr-only" : "mono", for: domId(def) }), def.label, def.fallback);
    const input = notes
      ? el("textarea", { class: "in", id: domId(def), rows: "2", maxlength: String(core.MAX_TEXT) })
      : el("input", {
        class: "in", id: domId(def), type: "text", maxlength: String(core.MAX_TEXT), autocomplete: "off", enterkeyhint: "done",
        autocapitalize: isName ? "words" : "sentences", spellcheck: isName ? "false" : null, placeholder: quiet ? def.label : null
      });
    const pv = el("div", { class: "pv" });
    const row = el("div", { class: "row " + def.type + " wide" }, [label, input, pv]);

    bindTyping(input, def.id);
    if (notes) input.addEventListener("input", () => grow(input));
    else input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") input.blur(); // done with this line: also closes the phone keyboard
    });

    fields[def.id] = {
      def: def,
      commit(final) {
        act({ type: "setValue", id: def.id, value: input.value }, !final);
      },
      update(force) {
        const value = core.valueOf(def, show.state);
        setInput(input, value.v, force);
        pv.textContent = value.v;
        if (notes) grow(input);
      }
    };
    return row;
  }

  function buildChoice(def) {
    const legend = el("p", { class: "mono", id: domId(def, "l"), text: def.label });
    let picked = { id: "", at: 0 }; // the option a tap has just selected, and when
    const buttons = (def.options || []).map((option) => {
      const button = el("button", { type: "button", class: "opt", "data-tone": option.tone, "aria-pressed": "false" },
        [el("span", { class: "dot", "aria-hidden": "true" }), el("span", { text: option.label })]);
      button.addEventListener("click", () => {
        // A double tap must not select and clear in one go (double-tap zoom is off, so both taps arrive):
        // a second tap right after the one that selected this option is dropped.
        if (picked.id === option.id && Date.now() - picked.at < DOUBLE_TAP_MS) return;
        act({ type: "choose", id: def.id, option: option.id });
        picked = core.valueOf(def, show.state).v === option.id ? { id: option.id, at: Date.now() } : { id: "", at: 0 };
      });
      return { id: option.id, node: button };
    });
    const group = el("div", { class: "opts", role: "group", "aria-labelledby": domId(def, "l") }, buttons.map((b) => b.node));

    const timeLabel = el("label", { class: "lbl", for: domId(def, "t"), text: def.timeLabel || "Time" });
    const time = el("input", { type: "time", class: "time empty", id: domId(def, "t") });
    const pv = el("span", { class: "pv" });
    const auto = el("span", { class: "auto mono", hidden: true });
    const stamp = el("div", { class: "stamp" }, [el("div", { class: "ctl" }, [time, pv]), auto]);
    const timeRow = el("div", { class: "row time" }, [timeLabel, stamp]);
    bindTimeInput(time, def.id);

    fields[def.id] = {
      def: def,
      commit() {
        if (time.validity && time.validity.badInput) return;
        act({ type: "setTime", id: def.id, value: time.value });
      },
      update(force) {
        const value = core.valueOf(def, show.state);
        buttons.forEach((b) => b.node.setAttribute("aria-pressed", b.id === value.v ? "true" : "false"));
        showStatus(def, value.v);
        setTimeInput(time, value.t, force);
        stamp.classList.toggle("edited", timeNote(value.t, auto, pv, def, value));
      }
    };
    return el("div", { class: "choice wide" }, [legend, group, timeRow]);
  }

  /*
   * The chosen status is repeated, in its colour, where it can be seen without scrolling to the buttons: in the
   * head of its section (the full wording) and, for the final status, in the sticky bar (the short wording).
   * Not chosen yet is said in both places too, as a to-do tag: with every check ticked the page is green from top
   * to bottom, and the decision that is still missing must not be the one thing nobody sees.
   */
  function showStatus(def, chosen) {
    const option = (def.options || []).filter((o) => o.id === chosen)[0];
    const tone = option ? option.tone : "mute";
    const head = statusTags[def.id];
    if (head) {
      head.textContent = option ? option.label : def.label + " — not set";
      head.dataset.tone = tone;
    }
    if (def.id !== statusFieldId) return;
    dom.barStatus.textContent = option ? own(SHORT_STATUS, option.id) || option.label : NO_STATUS;
    dom.barStatus.dataset.tone = tone;
    dom.barStatus.hidden = false;
  }

  function buildField(def, opts) {
    if (def.type === "check") return buildCheck(def, opts);
    if (def.type === "time") return buildTime(def, opts);
    if (def.type === "choice") return buildChoice(def);
    return buildText(def, opts);
  }

  // A crew member: the role as the caption, then the name and "Present" with the arrival time.
  function buildMember(group) {
    const roleId = "role-" + group.role;
    const block = el("div", { class: "member", role: "group", "aria-labelledby": roleId },
      [rosterLabel(el("p", { class: "mono role", id: roleId }), group.label, group.fallback)]);
    group.rows.forEach((row) => block.appendChild(buildField(defs[row.id], { quiet: true, block: block })));
    return block;
  }

  function buildIssue(group) {
    const inner = el("div", { class: "rows" });
    group.rows.forEach((row) => inner.appendChild(buildField(defs[row.id])));
    const tag = el("span", { class: "tag", hidden: true }); // "Open" / "Resolved", see renderIssues
    const node = el("div", { class: "issue wide", role: "group", "aria-label": group.label },
      [el("div", { class: "issue-head" }, [rosterLabel(el("h3", { class: "sub" }), group.label, group.fallback), tag]), inner]);
    issueSlots.push({ slot: group.slot, node: node, group: group, tag: tag });
    return node;
  }

  function buildSection(section, total) {
    const rows = el("div", { class: "rows" });
    let crew = null;
    let slots = 0;
    (section.rows || []).forEach((row) => {
      if (row.type !== "group") {
        crew = null;
        rows.appendChild(buildField(defs[row.id]));
      } else if (row.role) {
        if (!crew) {
          crew = el("div", { class: "crew wide" });
          rows.appendChild(crew);
        }
        crew.appendChild(buildMember(row));
      } else if (row.slot !== undefined) {
        crew = null;
        slots += 1;
        rows.appendChild(buildIssue(row));
      } else {
        crew = null;
        rows.appendChild(rosterLabel(el("h3", { class: "sub wide" }), row.label, row.fallback));
        row.rows.forEach((inner) => rows.appendChild(buildField(defs[inner.id])));
      }
    });
    if (section.addLabel) {
      const add = el("button", { type: "button", class: "btn", text: section.addLabel });
      add.addEventListener("click", revealNextIssue);
      addIssueWrap = el("div", { class: "add-wrap wide" }, [add]);
      rows.appendChild(addIssueWrap);
    }

    const count = el("span", { class: "mono sec-count" });
    const choice = (section.rows || []).filter((row) => row.type === "choice")[0];
    if (choice) statusTags[choice.id] = el("p", { class: "tag sec-status", "data-tone": "mute" });
    const node = el("section", { class: "card", id: "sec-" + section.key, "aria-labelledby": "h-" + section.key }, [
      el("header", { class: "card-head" }, [
        el("div", { class: "label" }, [el("span", { class: "mono", text: "( " + section.n + " / " + total + " )" }), count]),
        el("h2", { class: "head chrome", id: "h-" + section.key, text: section.title }),
        choice ? statusTags[choice.id] : null
      ]),
      rows
    ]);

    const chipCount = el("span", { class: "c" });
    const chip = el("button", { type: "button", class: "chip" }, [
      el("span", { class: "n", text: section.n }),
      el("span", { class: "t", text: own(SHORT_TITLES, section.key) || section.title }),
      chipCount
    ]);
    const ui = { key: section.key, title: section.title, node: node, count: count, chip: chip, chipCount: chipCount, slots: slots };
    chip.addEventListener("click", () => {
      jumpedTo = ui;
      scrollToNode(node);
      queueSpy();
    });
    sectionsUI.push(ui);
    return node;
  }

  let allChip = null;
  let allChipCount = null;

  function buildPage() {
    (template.header || []).forEach((row) => dom.hdrFields.appendChild(buildField(defs[row.id], { stacked: true })));

    const sections = template.sections || [];
    const total = String(sections.length).padStart(2, "0");
    const frag = document.createDocumentFragment();
    sections.forEach((section) => frag.appendChild(buildSection(section, total)));
    main.textContent = "";
    main.appendChild(frag);

    // On a phone the overall count rides at the head of the chips (the bar's top line has no room for it).
    allChipCount = el("span", { class: "c" });
    allChip = el("button", { type: "button", class: "chip all", "aria-label": "Back to the top" }, [el("span", { class: "t", text: "All" }), allChipCount]);
    allChip.addEventListener("click", () => scrollToNode($("top")));
    dom.chips.appendChild(allChip);
    sectionsUI.forEach((s) => dom.chips.appendChild(s.chip));
  }

  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  function scrollToNode(node) {
    node.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  }

  /* ------------------------------------------------------------------ patching the page */

  function patchFields(ids, force) {
    ids.forEach((id) => {
      if (fields[id]) fields[id].update(force);
    });
  }

  /*
   * The colour language of the stylesheet, as classes on whatever shows a count: none = nothing yet (an
   * outline), .part = begun (amber), .done = complete (green); .flag = an open issue (red).
   */
  function markCount(node, done, total) {
    node.classList.toggle("part", done > 0 && done < total);
    node.classList.toggle("done", total > 0 && done === total);
  }

  function renderProgress() {
    const p = core.progress(template, show.state);
    dom.overallNum.textContent = p.done + " / " + p.total;
    dom.overallBar.style.width = (p.total ? (100 * p.done) / p.total : 0) + "%";
    dom.overallMeter.setAttribute("aria-valuemax", String(p.total));
    dom.overallMeter.setAttribute("aria-valuenow", String(p.done));
    dom.barCount.textContent = "";
    dom.barCount.appendChild(el("b", { text: String(p.done) }));
    dom.barCount.appendChild(document.createTextNode(" / " + p.total));
    allChipCount.textContent = p.done + "/" + p.total;
    [dom.overall, dom.barCount, allChip].forEach((node) => markCount(node, p.done, p.total));

    let complete = 0; // of the sections that have checks
    let counted = 0;
    sectionsUI.forEach((s) => {
      const sp = own(p.sections, s.key) || { done: 0, total: 0 };
      let done = sp.total > 0 && sp.done === sp.total;
      let headText = sp.done + " / " + sp.total + (done ? " · done" : "");
      let chipText = sp.done + "/" + sp.total;
      let flag = false;
      let spoken = sp.done + " of " + sp.total + " done";
      if (sp.total > 0) {
        counted += 1;
        if (done) complete += 1;
      } else {
        // The issues section has nothing to tick: show how many are logged and whether any is still open
        // (red while one is; green once every logged issue has its "resolved at" time).
        const tally = issueTally();
        done = tally.logged > 0 && tally.open === 0;
        flag = tally.open > 0;
        headText = s.slots ? (tally.logged ? tally.logged + " logged · " + tally.open + " open" : "None logged") : "";
        chipText = s.slots && tally.logged ? String(tally.logged) : "";
        spoken = s.slots ? tally.logged + " logged, " + tally.open + " open" : "";
      }
      s.count.textContent = headText;
      s.chipCount.textContent = chipText;
      s.chipCount.hidden = chipText === "";
      [s.chip, s.node].forEach((node) => {
        node.classList.toggle("part", sp.done > 0 && !done);
        node.classList.toggle("done", done);
        node.classList.toggle("flag", flag);
      });
      s.chip.setAttribute("aria-label", "Section " + s.title + (spoken ? ", " + spoken : ""));
    });
    dom.overallSecs.textContent = complete + " / " + counted;
  }

  // "" while nothing is written; then the issue is "open" until its "resolved at" time is filled in
  // (ids end in .issue / .resolved_at).
  function issueState(s) {
    const issue = s.group.rows.filter((row) => /\.issue$/.test(row.id))[0];
    const resolved = s.group.rows.filter((row) => /\.resolved_at$/.test(row.id))[0];
    if (!issue || core.valueOf(issue, show.state).v.trim() === "") return "";
    return !resolved || core.valueOf(resolved, show.state).v === "" ? "open" : "resolved";
  }

  function issueTally() {
    const tally = { logged: 0, open: 0 };
    issueSlots.forEach((s) => {
      const state = issueState(s);
      if (state) tally.logged += 1;
      if (state === "open") tally.open += 1;
    });
    return tally;
  }

  // Slot 1 is always there; a slot with content, and every slot before it, is always shown.
  function renderIssues() {
    let withContent = 0;
    issueSlots.forEach((s) => {
      if (core.groupHasContent(s.group, show.state)) withContent = Math.max(withContent, s.slot);
    });
    const visible = Math.max(1, issueReveal, withContent);
    issueSlots.forEach((s) => {
      // Red "Open" tag and edge while it is open, green "Resolved" once it has its time.
      const state = issueState(s);
      s.node.classList.toggle("open", state === "open");
      s.node.classList.toggle("resolved", state === "resolved");
      s.tag.textContent = state === "open" ? "Open" : state === "resolved" ? "Resolved" : "";
      s.tag.dataset.tone = state === "open" ? "bad" : "good";
      s.tag.hidden = !state;
      const hide = s.slot > visible;
      if (s.node.hidden && !hide) {
        s.node.hidden = false;
        growAll(s.node);
      } else {
        s.node.hidden = hide;
      }
    });
    if (addIssueWrap) addIssueWrap.hidden = visible >= issueSlots.length;
    return visible;
  }

  function revealNextIssue() {
    issueReveal = Math.min(issueSlots.length, renderIssues() + 1);
    renderIssues();
    const opened = issueSlots.filter((s) => s.slot === issueReveal)[0];
    const first = opened && opened.node.querySelector("textarea, input");
    if (first) first.focus();
  }

  function renderDate() {
    const long = core.formatShowDate(show.date);
    const today = new Date();
    const upcoming = core.upcomingShowDate(today);
    const isThisWeek = show.date === upcoming;
    // On the weekend after a show the coming Friday is the NEXT show; "this week's" was last night.
    const weekend = today.getDay() === 0 || today.getDay() === 6;
    const upcomingName = weekend && upcoming > core.localDateStr(today) ? "Next show" : "This week's show";
    dom.dateText.textContent = long;
    dom.printDate.textContent = long;
    dom.barDate.textContent = long.slice(0, 10); // "FRI 09 OCT"
    if (document.activeElement !== dom.dateInput || !dom.dateInput.value) dom.dateInput.value = show.date;
    dom.thisWeek.hidden = isThisWeek;
    dom.thisWeek.textContent = upcomingName;
    const finishing = !isThisWeek && show.date === defaultShowDate();
    dom.dateNote.textContent = isThisWeek ? upcomingName : finishing ? "Last Friday — post-show open" : "Not this week's show";
    dom.dateNote.classList.toggle("warn", !isThisWeek);
    // The sticky bar carries the warning down the page (amber date; the words from tablet width up).
    document.body.classList.toggle("off-week", !isThisWeek);
    // Judged here (when a show is opened and on every calendar check), not at the moment of a change:
    // one stray tick in an empty show from last Friday would otherwise make it look "being finished".
    offWeek = !isThisWeek && !finishing;
    if (!offWeek) offWeekTold = "";
  }

  function renderAll() {
    patchFields(Object.keys(fields));
    renderDate();
    renderProgress();
    renderIssues();
  }

  /* ------------------------------------------------------------------ user actions */

  const typingTimers = Object.create(null); // fieldId -> timer of a value still being typed
  let deferred = Object.create(null);       // fieldId -> remote value held back while its field has the focus
  let heldStamps = Object.create(null);     // fieldId -> an auto time stamp waits until this field is finished

  const holdTimers = Object.create(null);   // fieldId -> timer that releases a held stamp after a pause in typing

  // The field being edited ("" when none): remote data must not replace it until it is left. A field whose
  // window has lost the focus is not being edited, even though it still is document.activeElement.
  function typingId() {
    const active = document.activeElement;
    return active && active.dataset && active.dataset.field && pageFocused() ? active.dataset.field : "";
  }
  const typingIds = () => (typingId() ? [typingId()] : []);

  /*
   * Runs one action through the core rules and stores the result. With `hold` (text still being typed)
   * a time stamp that the text would trigger is kept back, so the Sheet never shows a time next to half a
   * word. The time itself is taken now: "flagged at" is when the issue was first typed, and it is written
   * once the producer finishes the line (change / blur) or pauses for a few seconds.
   */
  function act(action, hold) {
    if (!show) return [];
    const before = show.state;
    const result = core.applyAction(before, template, action, clock());
    if (!result.changed.length) return [];
    const next = result.state; // a fresh copy made by the core: safe to adjust
    let changed = result.changed;
    if (hold) {
      const targets = stampTargets[action.id] || [];
      const held = changed.filter((id) => id !== action.id && targets.indexOf(id) !== -1);
      if (held.length) {
        // The time is taken now, at the first keystroke ("HH:MM"); it is written when the line is finished.
        heldStamps[action.id] = heldStamps[action.id] || core.valueOf(defs[held[0]], next).v;
        held.forEach((id) => {
          const prev = own(before, id);
          if (prev) next[id] = prev;
          else delete next[id];
        });
        changed = changed.filter((id) => held.indexOf(id) === -1);
      }
    }
    show.state = next;
    localChange(changed);
    offerUndo(action, before);
    return changed;
  }

  // v = a = hm on a time field of `rec`, stored as a change made now (the time itself may be an earlier one).
  // Returns the ids that changed; they are marked dirty.
  function stampField(rec, id, hm) {
    const result = core.applyAction(rec.state, template, { type: "stampNow", id: id }, Object.assign(clock(), { hm: hm }));
    rec.state = result.state;
    result.changed.forEach((changedId) => {
      rec.dirty[changedId] = rec.state[changedId].u;
    });
    return result.changed;
  }

  /*
   * One stray tap can wipe a recorded time: unticking a row, "Now" on a field that already holds a time,
   * tapping the selected final status again. Each of these says what it replaced and offers it back.
   * Undo only acts while nothing else has happened to the field since (same show, same `u`): never over a
   * newer change from here or from another device.
   */
  function offerUndo(action, before) {
    const def = defs[action.id];
    const old = own(before, action.id);
    if (!def || !old) return;
    const was = core.valueOf(def, before);
    const is = core.valueOf(def, show.state);
    let message = "";
    if (action.type === "toggle" && was.v === 1 && is.v === 0 && (was.t || was.a)) {
      message = "Cleared " + core.to12h(was.t || was.a);
    } else if (action.type === "stampNow" && was.v !== "" && was.v !== is.v) {
      message = "Replaced " + core.to12h(was.v);
    } else if (action.type === "choose" && was.v !== "" && is.v === "") {
      const option = (def.options || []).filter((o) => o.id === was.v)[0];
      message = "Cleared " + (option ? option.label : "the status") + (was.t ? " · " + core.to12h(was.t) : "");
    }
    if (!message) return;
    const date = show.date;
    const id = action.id;
    const stamp = show.state[id].u;
    undoToast(message, () => {
      const current = show && show.date === date ? own(show.state, id) : null;
      if (!current || current.u !== stamp) return;
      const c = clock();
      const next = Object.assign({}, show.state);
      next[id] = Object.assign({}, old, { u: Math.max(c.now, stampOf(current) + 1), by: c.by });
      show.state = next;
      localChange([id]);
    });
  }

  function localChange(ids) {
    ids.forEach((id) => {
      show.dirty[id] = show.state[id].u;
    });
    writeRecord(show);
    noteRemembered(show, ids);
    patchFields(ids);
    if (ids.some((id) => nameKeys[id])) refreshNames();
    renderProgress();
    renderIssues();
    lastLocalChange = Date.now();
    lastTouch = lastLocalChange;
    sync.activity = Date.now();
    sync.rejected = false; // the next save is a different one
    rememberTab();
    if (offWeek && offWeekTold !== show.date) {
      // Changing another week's show can be meant (looking something up, a correction), but it should
      // never go unnoticed: said once per show, on the first change.
      offWeekTold = show.date;
      toast("This is " + core.formatShowDate(show.date) + " — not this week's show");
    }
    scheduleSave();
  }

  // The show this tab has open is remembered for the tab, so a reload (or a phone restoring a discarded tab)
  // comes back to a show the producer picked instead of jumping to another one.
  function rememberTab() {
    const memo = { date: show.date, manual: !autoDate, at: Date.now(), link: tabLink };
    if (lastReload) memo.reloaded = lastReload;
    tabMemory.write(memo);
  }

  function scheduleCommit(id) {
    clearTimeout(typingTimers[id]);
    typingTimers[id] = setTimeout(() => commitField(id, false), TYPING_DEBOUNCE_MS);
  }

  function commitField(id, final) {
    clearTimeout(typingTimers[id]);
    delete typingTimers[id];
    const field = fields[id];
    if (!field || !show) return;
    field.commit(final);
    const heldAt = heldStamps[id];
    if (!heldAt) return;
    clearTimeout(holdTimers[id]);
    delete holdTimers[id];
    const filled = core.valueOf(field.def, show.state).v.trim() !== "";
    if (final || !filled) {
      // Finished, or typed and deleted again (then nothing is stamped).
      delete heldStamps[id];
      if (!filled) return;
      let stamped = [];
      (stampTargets[id] || []).forEach((target) => {
        if (core.valueOf(defs[target], show.state).v === "") stamped = stamped.concat(stampField(show, target, heldAt));
      });
      if (stamped.length) localChange(stamped);
    } else {
      // Still typing: a pause of a few seconds releases the stamp even if the cursor stays in the field.
      holdTimers[id] = setTimeout(() => commitField(id, true), HOLD_RELEASE_MS);
    }
  }

  // The field was left (or its line was completed): store it, then let waiting remote data in.
  function finishEditing(id) {
    commitField(id, true);
    releaseDeferred([id]);
    // After the event that brought us here: by then the focus has really moved on.
    setTimeout(() => {
      patchFields([id]);
      refreshNames();
    }, 0);
  }

  /*
   * Remote values that waited for their field to be left go into the state now (`ids` omitted: all of them).
   * Their inputs are rewritten whatever the focus says. This runs only when the producer has finished with
   * the field (change / blur) or the page is going away, and an input left showing the old text would be
   * read back and saved as a brand-new edit at the next blur, over the other device's newer value.
   */
  function releaseDeferred(ids) {
    if (!show) return;
    const incoming = {};
    (ids || Object.keys(deferred)).forEach((id) => {
      if (deferred[id]) incoming[id] = deferred[id];
      delete deferred[id];
    });
    if (!Object.keys(incoming).length) return;
    const changed = mergeFields(show, incoming, [], []);
    if (!changed.length) return;
    patchFields(changed, true);
    const stamped = stampCompleted(show, changed);
    writeRecord(show);
    renderProgress();
    renderIssues();
    if (stamped.length) scheduleSave();
  }

  // Everything still in a debounce, or waiting for its field to be finished, goes into the state now.
  function flushTyping() {
    Object.keys(typingTimers).concat(Object.keys(heldStamps)).forEach((id) => commitField(id, true));
  }

  /* ------------------------------------------------------------------ remote data -> local state */

  /*
   * Merges values from the Sheet (or from another tab) into a record with the shared rule (newer `u`
   * wins), plus two cases the rule alone cannot settle:
   *   - `confirmed`: fields the Sheet has just accepted from us. Its copy is the truth even when it had
   *     to pull our `u` back (a device clock running ahead), otherwise later changes from another device
   *     would lose against our inflated `u`.
   *   - prefills (u = 0 on both sides): the Sheet's wins, so every device shows what the Sheet shows.
   * `skip` = fields being typed in. Returns the ids whose value was replaced.
   */
  function mergeFields(rec, incoming, skip, confirmed) {
    if (!isObj(incoming)) return [];
    const before = rec.state;
    const base = Object.assign({}, before);
    confirmed.forEach((id) => {
      if (isObj(own(incoming, id)) && skip.indexOf(id) === -1) delete base[id];
    });
    const merged = core.merge(base, incoming, skip);
    const next = Object.assign({}, merged.state);
    const changed = merged.changed.slice();
    confirmed.forEach((id) => {
      if (!own(next, id) && own(before, id)) next[id] = before[id]; // the Sheet's copy was unusable: keep ours
    });
    Object.keys(incoming).forEach((id) => {
      const theirs = incoming[id];
      const ours = own(next, id);
      if (!isObj(theirs) || !ours || skip.indexOf(id) !== -1 || typeof theirs.v !== "string") return;
      if (stampOf(theirs) !== 0 || stampOf(ours) !== 0 || ours.v === theirs.v) return;
      next[id] = { v: theirs.v.slice(0, core.MAX_TEXT), u: 0 };
      if (changed.indexOf(id) === -1) changed.push(id);
    });
    rec.state = next;
    changed.forEach((id) => {
      delete rec.dirty[id]; // what we had was older: nothing left to send for this field
    });
    noteRemembered(rec, changed);
    if (rec === show) {
      patchFields(changed);
      if (changed.some((id) => nameKeys[id])) refreshNames();
    }
    return changed;
  }

  // Would the Sheet's copy replace ours under the rules of mergeFields (newer `u`; between two prefills the Sheet's)?
  function replaces(ours, theirs) {
    if (!ours) return true;
    if (stampOf(theirs) > stampOf(ours)) return true;
    return stampOf(theirs) === 0 && stampOf(ours) === 0 && typeof theirs.v === "string" && ours.v !== theirs.v;
  }

  /*
   * stampWhenAllChecked for ticks that arrived by sync (core.stampsDue): when a merge completed a list whose
   * time was never written, it is stamped here with the time of the completing tick, as a change of this
   * device. Returns the ids stamped (they are dirty and go up with the next save).
   */
  function stampCompleted(rec, changed) {
    let stamped = [];
    core.stampsDue(template, rec.state, changed).forEach((due) => {
      stamped = stamped.concat(stampField(rec, due.id, due.hm));
    });
    if (stamped.length && rec === show) patchFields(stamped);
    return stamped;
  }

  /*
   * A full state from the Sheet for one show (reply to a load or a save); `rev` is the revision it stands for.
   * The field being edited is left alone (`skip`):
   *   - if the Sheet has just accepted it from us unchanged, its copy is adopted (same content, but the Sheet
   *     may have pulled a too-far-ahead `u` back; kept as it was, the field would be sent again after every
   *     reply and would beat other devices' later edits);
   *   - if the Sheet holds something that would replace it, that value waits in `deferred` until the field is
   *     left. It lives in memory only, so the stored revision is NOT advanced: after a reload the next load
   *     asks for the full state again instead of hearing "unchanged".
   */
  function applyServerState(rec, state, confirmed, rev) {
    const live = rec === show;
    const skip = live ? typingIds() : [];
    let changed = mergeFields(rec, state, skip, confirmed);
    let held = false;
    skip.forEach((id) => {
      const theirs = own(state, id);
      const ours = own(rec.state, id);
      if (!isObj(theirs)) return;
      const same = !!ours && ours.v === theirs.v && str(ours.t) === str(theirs.t) && str(ours.a) === str(theirs.a);
      if (same && confirmed.indexOf(id) !== -1) {
        const incoming = {};
        incoming[id] = theirs;
        rec.state = Object.assign({}, rec.state, core.merge({}, incoming).state);
      } else if (replaces(ours, theirs)) {
        deferred[id] = theirs;
        held = true;
      }
    });
    const pre = {};
    Object.keys(state).forEach((id) => {
      if (isObj(state[id]) && stampOf(state[id]) === 0) pre[id] = 1;
    });
    rec.pre = pre;
    // Whatever we hold that the Sheet lacks, or holds an older copy of, goes up again (a show made
    // offline, a Sheet that was reset or replaced, a change left behind by another tab).
    Object.keys(rec.state).forEach((id) => {
      const u = stampOf(rec.state[id]);
      if (u > 0 && stampOf(own(state, id)) < u) rec.dirty[id] = u;
    });
    changed = changed.concat(stampCompleted(rec, changed));
    if (!held) rec.rev = rev;
    return changed;
  }

  /*
   * The show was removed in the Sheet (menu "Remove a show…") at `at`, on the Sheet's clock. Whatever this
   * device holds for it from before that moment goes, instead of being sent back and bringing the show
   * back; a change made later stays (and starts the show afresh). Returns the ids that were dropped.
   */
  function dropRemoved(rec, at) {
    const gone = Object.keys(rec.state).filter((id) => {
      const u = stampOf(rec.state[id]);
      return u > 0 && u <= at;
    });
    if (!gone.length) return [];
    const next = Object.assign({}, rec.state);
    gone.forEach((id) => {
      delete next[id];
      delete rec.dirty[id];
      if (rec === show) delete deferred[id];
    });
    rec.state = next;
    rec.pre = {}; // the Sheet holds nothing of it any more
    noteRemembered(rec, gone); // nor does a later show get "same as last week" from a show that was removed
    const refilled = refillPrefills(rec, rec === show ? typingIds() : []);
    if (rec === show) {
      patchFields(gone.concat(refilled));
      refreshNames();
      toast("This show was removed in the Sheet. What this device still held of it was cleared.");
    }
    return gone;
  }

  // A show that has not happened yet: dated after today, or today and not yet declared ready (final status).
  function stillToCome(rec) {
    const today = core.localDateStr(new Date());
    if (!today || rec.date < today) return false;
    if (rec.date > today) return true;
    return !statusFieldId || core.valueOf(defs[statusFieldId], rec.state).v === "";
  }

  // Did this reply bring the Sheet's crew names and defaults along with the show's state?
  const carriesConfig = (reply) => isObj(reply.roster) && isObj(reply.defaults);

  /*
   * A crew name or a default was changed in the Sheet AFTER this show got its prefills. The prefills the
   * Sheet holds (u = 0, `pre`) are the Sheet's own, so refillPrefills leaves them alone; left at that, the
   * labels would follow the new roster while the Name field, and the Sheet, kept the old person. Here such
   * a field is brought in line as an ordinary change, so it reaches the Sheet and every other device. It is
   * marked SHEET_BY: nobody typed it, and it keeps following the Crew / Settings tabs. The rules:
   *   - only right after a reply that carried the Sheet's current names and defaults together with this
   *     show's state (never from the cached roster: a device that is behind must not write old names back);
   *   - only a show that is still to come (stillToCome). A show that is over keeps the names it had: they
   *     are the record of who worked it;
   *   - never a value somebody typed, never the field being typed in, and never the name of a crew member
   *     who is already ticked present.
   * Returns the ids changed (they are dirty and go up with the next save).
   */
  function adoptSheetDefaults(rec) {
    if (rec !== show || !stillToCome(rec)) return [];
    const fresh = core.defaultsFor(template, cache.roster, cache.defaults, {});
    const skip = typingIds();
    let changed = [];
    sheetDefaultIds.forEach((id) => {
      const current = own(rec.state, id);
      if (!current || skip.indexOf(id) !== -1 || deferred[id]) return;
      const fromSheet = stampOf(current) === 0 ? !!own(rec.pre, id) : current.by === SHEET_BY;
      const want = own(fresh, id) ? fresh[id].v : "";
      if (!fromSheet || str(current.v) === want) return;
      if (presentOf[id] && core.isTicked(own(rec.state, presentOf[id]))) return;
      const result = core.applyAction(rec.state, template, { type: "setValue", id: id, value: want }, Object.assign(clock(), { by: SHEET_BY }));
      rec.state = result.state;
      result.changed.forEach((changedId) => {
        rec.dirty[changedId] = rec.state[changedId].u;
      });
      changed = changed.concat(result.changed);
    });
    if (changed.length) {
      patchFields(changed);
      refreshNames();
    }
    return changed;
  }

  function afterRemoteChange(rec, changed) {
    writeRecord(rec);
    if (rec !== show) return;
    if (changed.length) {
      renderProgress();
      renderIssues();
      sync.activity = Date.now();
    }
    if (hasDirty(rec) && !sync.saveTimer) sync.saveDue = true;
  }

  // Roster and defaults from hello / load: cached for offline starts, then labels and prefills follow.
  function applyConfig(roster, defaults) {
    let changed = false;
    if (isObj(roster)) {
      const clean = {};
      Object.keys(template.roles || {}).forEach((key) => {
        clean[key] = oneLine(own(roster, key), MAX_NAME);
      });
      if (JSON.stringify(clean) !== JSON.stringify(cache.roster)) {
        cache.roster = clean;
        changed = true;
      }
    }
    if (isObj(defaults)) {
      const clean = {};
      ["location", "liveTime", "crewCall", "recordingStart"].forEach((key) => {
        clean[key] = oneLine(own(defaults, key), 200);
      });
      if (JSON.stringify(clean) !== JSON.stringify(cache.defaults)) {
        cache.defaults = clean;
        changed = true;
      }
    }
    if (!changed) return;
    saveCache();
    layoutCache = null;
    if (show) {
      const ids = refillPrefills(show, typingIds());
      if (ids.length) {
        writeRecord(show);
        patchFields(ids);
        renderProgress(); // a name for the spare crew slot makes its box count
      }
    }
    names = null; // worked out again from the new roster (and relabelled) below
    if (show) refreshNames();
    else relabel();
  }

  /* ------------------------------------------------------------------ sync engine (SPEC §4) */

  const sync = {
    busy: false,       // one request in flight at a time
    job: "",
    saveTimer: 0,      // debounce after a change
    saveDue: false,    // the open show should be saved as soon as possible
    wantLoad: false,   // the open show should be (re)loaded
    wantHello: false,  // refresh roster / defaults / Sheet link
    waitTimer: 0,      // backing off after a failure, or waiting out "busy"
    step: 0,           // position in BACKOFF_MS
    pollTimer: 0,
    flushQ: [],        // other dates to save BEFORE loading the open show (the show just left)
    bgQ: [],           // other dates with unsaved changes, saved one at a time when idle
    failed: false,     // the last request did not get through
    lastFail: "",      // how: "offline" (no answer at all) | "error" | "rejected" (something answered, see settle)
    failNote: "",      // what the Sheet (or whatever answered) said, for the Settings dialog and the banner
    rejected: false,   // the Sheet refused the open show's save as it is: not sent again until something changes
    kicked: false,     // kick() was asked for while a request was under way
    fails: {},         // date -> failed saves of a show that is not open (see nextJob)
    parked: {},        // date -> given up for now; tried again after the next reconnect / return to the page / start
    fullOnly: {},      // date -> the Sheet refused this show's save without its layout: always send the layout
    flights: [],       // the saves under way: { date, sent, kept } (kept = sent to outlive the page)
    keptBytes: 0,      // bytes of keepalive request bodies in flight
    epoch: 0,          // raised when this device is erased: answers to earlier requests are dropped
    lastOk: 0,         // server-aligned time of the last successful exchange
    helloAt: 0,
    activity: Date.now(), // last local or remote change, sets the polling pace
    unloading: false,
    notified: {}       // error toasts already shown since the last success
  };

  let layoutCache = null;
  const layout = () => layoutCache || (layoutCache = core.buildLayout(template, cache.roster));

  /*
   * The layout names people ("Camera switching tested with …"). When a show has a stand-in typed into a
   * crew name field, ITS layout must carry that name, on the page, the print-out and the Sheet alike. Nearly
   * every show has none and uses the cached roster layout above; for the others the layout is built from the
   * names of that record for the one request `send` makes (a request serialises its body at once).
   */
  function withLayoutOf(rec, send) {
    const crew = rec === show && names ? names : core.rosterFor(template, cache.roster, rec.state);
    if (sameNames(crew, cache.roster)) return send();
    const kept = layoutCache;
    layoutCache = core.buildLayout(template, crew);
    try {
      return send();
    } finally {
      layoutCache = kept;
    }
  }

  // The saves under way, so the same one is not sent twice while the page hides (see flushOnHide).
  function takeOff(date, sent, opts) {
    const flight = { date: date, sent: JSON.stringify(sent), kept: opts.kept === true };
    sync.flights.push(flight);
    return flight;
  }
  const land = (flight) => {
    sync.flights = sync.flights.filter((other) => other !== flight);
  };

  const sizeOf = (text) => (typeof Blob === "function" ? new Blob([text]).size : text.length * 3);
  // "Something answered, but not the checklist's web app": an error page, a sign-in page, a broken reply.
  const notTheSheet = (message) => Object.assign(new Error(message), { kind: "reply" });

  const pageHidden = () => sync.unloading || document.visibilityState === "hidden";

  // One POST to the web app. text/plain keeps it a "simple" request: Apps Script cannot answer preflights.
  function request(action, params, opts) {
    const url = endpoint();
    if (!url) return Promise.reject(new Error("No web app address"));
    const envelope = { api: 1, action: action, code: opts && typeof opts.code === "string" ? opts.code : str(settings.code), device: deviceName() };
    const body = JSON.stringify(Object.assign({}, params, envelope));
    const init = { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body, redirect: "follow" };
    let kept = 0;
    if (opts && opts.keepalive) {
      // This request should outlive the page. Browsers only allow so many keepalive bytes in flight; a body
      // that does not fit goes without the layout when the Sheet already has one for this show (`light`).
      const room = KEEPALIVE_MAX_BYTES - sync.keptBytes;
      if (sizeOf(body) > room && opts.light) {
        const light = JSON.stringify(Object.assign({}, params, { tv: undefined, layout: undefined }, envelope));
        if (sizeOf(light) <= room) {
          init.body = light;
          opts.wentLight = true;
        }
      }
      if (sizeOf(init.body) <= room) {
        kept = sizeOf(init.body);
        sync.keptBytes += kept;
        init.keepalive = true;
        opts.kept = true;
      }
    }
    let timer = 0;
    const over = () => {
      clearTimeout(timer);
      sync.keptBytes -= kept;
      kept = 0;
    };
    let hiccups = 0;
    const attempt = () => {
      clearTimeout(timer);
      if (typeof AbortController === "function") {
        const aborter = new AbortController();
        init.signal = aborter.signal;
        timer = setTimeout(() => aborter.abort(), REQUEST_TIMEOUT_MS);
      }
      return fetch(url, init)
        .then((response) => {
          if (!response.ok) {
            // Google's intermittent "Sorry, unable to open the file" page: ask again (twice) before telling anyone.
            // Not for a keepalive request: the page is going away and cannot wait.
            if (response.status === 404 && hiccups < DRIVE_HICCUP_RETRY_MS.length && !init.keepalive) {
              return new Promise((resolve) => setTimeout(resolve, DRIVE_HICCUP_RETRY_MS[hiccups++])).then(attempt);
            }
            throw notTheSheet("the web app address answered with an error page (HTTP " + response.status + ")");
          }
          return response.json().then((data) => data, () => {
            throw notTheSheet("the web app address answered with a page instead of data — check that it is deployed for “Anyone”");
          });
        });
    };
    return attempt()
      .then((reply) => {
        over();
        if (!isObj(reply)) throw notTheSheet("the web app sent an unreadable answer");
        if (isNum(reply.now)) noteServerTime(reply.now);
        return reply;
      }, (err) => {
        over();
        throw err;
      });
  }

  // What goes up: every dirty field, plus the prefills the Sheet has not seen (u = 0 never overwrites there).
  function buildPatch(rec) {
    const patch = {};
    const sent = {};
    Object.keys(rec.dirty).forEach((id) => {
      const value = own(rec.state, id);
      if (!value) {
        delete rec.dirty[id];
        return;
      }
      patch[id] = value;
      sent[id] = rec.dirty[id];
    });
    Object.keys(rec.state).forEach((id) => {
      if (!own(patch, id) && stampOf(rec.state[id]) === 0 && !own(rec.pre, id) && core.FIELD_ID_RE.test(id)) patch[id] = rec.state[id];
    });
    return { patch: patch, sent: sent };
  }

  function applySaveReply(date, reply, sent) {
    const rec = recordFor(date);
    const confirmed = [];
    Object.keys(sent).forEach((id) => {
      // Changed again while the request was under way? Then it stays dirty and goes up with the next save.
      if (rec.dirty[id] !== sent[id]) return;
      delete rec.dirty[id];
      confirmed.push(id);
    });
    const rev = isNum(reply.rev) ? reply.rev : rec.rev;
    let changed = [];
    applyConfig(reply.roster, reply.defaults);
    if (isNum(reply.removedAt) && reply.removedAt > 0) changed = dropRemoved(rec, reply.removedAt);
    if (isObj(reply.state)) changed = changed.concat(applyServerState(rec, reply.state, confirmed, rev));
    else rec.rev = rev;
    if (carriesConfig(reply)) changed = changed.concat(adoptSheetDefaults(rec));
    afterRemoteChange(rec, changed);
    if (reply.warning && !sync.notified.warning) {
      sync.notified.warning = true;
      toast("Saved. The Sheet's readable tab will catch up on the next change.");
    }
  }

  function applyLoadReply(date, reply) {
    // Crew names and defaults come with every answer about a show, "unchanged" included.
    applyConfig(reply.roster, reply.defaults);
    const rec = recordFor(date);
    let changed = [];
    if (!reply.unchanged) {
      if (isNum(reply.removedAt) && reply.removedAt > 0) changed = dropRemoved(rec, reply.removedAt);
      const state = reply.exists !== false && isObj(reply.state) ? reply.state : {};
      changed = changed.concat(applyServerState(rec, state, [], reply.exists !== false && isNum(reply.rev) ? reply.rev : 0));
    }
    if (carriesConfig(reply)) changed = changed.concat(adoptSheetDefaults(rec));
    if (reply.unchanged && !changed.length) return;
    afterRemoteChange(rec, changed);
  }

  // A reply with ok:false -> what the engine should do next.
  function replyFailure(reply) {
    const code = str(reply.error);
    if (code === "bad_code") {
      settings.connected = false;
      saveSettings();
      renderStatus();
      openConnect("The access code was not accepted. Enter the current code to keep saving to the Sheet.", true);
      return "stop";
    }
    if (code === "busy") return "busy";
    const detail = oneLine(reply.message, 160);
    sync.failNote = detail.replace(/[.\s]+$/, "") || "the Sheet reported an error";
    if (!sync.notified[code]) {
      sync.notified[code] = true;
      toast("The Sheet could not take this" + (detail ? ": " + detail : ".") + " It is still saved on this device.", "bad");
    }
    // "rejected": sending the same thing again cannot work. "error": the Sheet had a problem of its own.
    return code === "bad_request" || code === "too_large" ? "rejected" : "error";
  }

  // Outcome of one request: "ok" | "busy" | "offline" (no answer) | "error" | "rejected" | "stop" (bad code).
  // An error page or anything else that is not the web app's JSON is an "error", not "offline": the network
  // is fine, and the producer should not go looking for the Wi-Fi.
  const settle = (work) => work.then((reply) => (reply.ok === true ? "ok" : replyFailure(reply)), (err) => {
    const answered = !!err && err.kind === "reply";
    sync.failNote = answered ? str(err.message) : "";
    return answered ? "error" : "offline";
  });

  function saveDate(date) {
    const rec = recordFor(date);
    if (!hasDirty(rec)) return Promise.resolve("ok");
    const built = buildPatch(rec);
    const opts = { keepalive: pageHidden(), light: rec.rev > 0 && !sync.fullOnly[date] };
    const sending = withLayoutOf(rec, () => request("save", { date: date, patch: built.patch, tv: template.tv, layout: layout() }, opts));
    const flight = takeOff(date, built.sent, opts);
    const epoch = sync.epoch;
    return settle(sending.then((reply) => {
      if (reply.ok === true && epoch === sync.epoch) applySaveReply(date, reply, built.sent);
      return reply;
    })).then((outcome) => {
      land(flight);
      if (outcome !== "rejected" || !opts.wentLight) return outcome;
      // Refused in the short form it was sent in to outlive the page (no layout; the Sheet no longer has
      // one for this show): the full request may well be accepted. A failure to try again, with the layout.
      sync.fullOnly[date] = true;
      return "error";
    });
  }

  function loadDate(date) {
    const params = { date: date };
    const rev = recordFor(date).rev;
    if (rev > 0) params.rev = rev; // lets the Sheet answer "unchanged" without sending the state
    const epoch = sync.epoch;
    return settle(request("load", params).then((reply) => {
      if (reply.ok === true && epoch === sync.epoch) applyLoadReply(date, reply);
      return reply;
    }));
  }

  function applyHello(reply) {
    cache.sheetName = oneLine(reply.sheetName, 120);
    cache.sheetUrl = SHEET_URL_RE.test(str(reply.sheetUrl)) ? reply.sheetUrl : "";
    cache.build = oneLine(reply.build, 40); // which version of Code.gs is deployed ("" from one that does not say)
    saveCache();
    sync.helloAt = Date.now();
    applyConfig(reply.roster, reply.defaults);
  }

  function hello() {
    const epoch = sync.epoch;
    return settle(request("hello", {}).then((reply) => {
      if (reply.ok === true && epoch === sync.epoch) applyHello(reply);
      return reply;
    }));
  }

  const dropFrom = (list, date) => {
    const at = list.indexOf(date);
    if (at !== -1) list.splice(at, 1);
  };

  // Picks the next request. Order: the show just left, the open show (save, else load), hello, old shows.
  function nextJob() {
    dropFrom(sync.flushQ, show.date);
    dropFrom(sync.bgQ, show.date);
    const other = (queue) => {
      const date = queue[0];
      return {
        kind: "save",
        run: () => saveDate(date),
        done: () => {
          dropFrom(queue, date);
          delete sync.fails[date];
        },
        // One show must never hold up the others. After a failed attempt it waits at the back of the
        // background queue. A show the Sheet refused, or failed on MAX_SAVE_TRIES times, is parked (the pill
        // says so) until the next reconnect, return to the page or start: see retryParked().
        undo: (outcome) => {
          dropFrom(queue, date);
          if (outcome === "rejected") sync.fails[date] = MAX_SAVE_TRIES;
          else if (outcome === "error") sync.fails[date] = (sync.fails[date] || 0) + 1;
          if ((sync.fails[date] || 0) >= MAX_SAVE_TRIES) sync.parked[date] = true;
          else if (sync.bgQ.indexOf(date) === -1) sync.bgQ.push(date);
        }
      };
    };
    if (sync.flushQ.length) return other(sync.flushQ);
    if (hasDirty(show) && !sync.rejected && (sync.saveDue || sync.wantLoad)) {
      // A save returns the merged state, so it also serves as the load that was asked for.
      const date = show.date;
      const wanted = { saveDue: sync.saveDue, wantLoad: sync.wantLoad };
      sync.saveDue = false;
      sync.wantLoad = false;
      return {
        kind: "save",
        run: () => saveDate(date),
        undo: (outcome) => {
          // Refused as it is (too large, malformed): the same body again cannot work, and it must not keep
          // the loads from running. The next change here, or a reconnect, tries again.
          if (outcome === "rejected") sync.rejected = true;
          else sync.saveDue = true;
          sync.wantLoad = sync.wantLoad || wanted.wantLoad;
        }
      };
    }
    if (sync.wantLoad) {
      const date = show.date;
      sync.wantLoad = false;
      return { kind: "load", run: () => loadDate(date), undo: () => { sync.wantLoad = true; } };
    }
    if (sync.wantHello) {
      sync.wantHello = false;
      return { kind: "hello", run: hello, undo: () => { sync.wantHello = true; } };
    }
    if (sync.bgQ.length) return other(sync.bgQ);
    return null;
  }

  function pump() {
    if (sync.busy || sync.waitTimer || !show || !canSync()) return;
    const job = nextJob();
    if (!job) {
      renderStatus();
      return;
    }
    sync.busy = true;
    sync.job = job.kind;
    renderStatus();
    job.run().then((outcome) => finishJob(job, outcome), () => finishJob(job, "offline"));
  }

  function finishJob(job, outcome) {
    sync.busy = false;
    sync.job = "";
    if (outcome === "ok") {
      sync.failed = false;
      sync.lastFail = "";
      if (!sync.rejected) sync.failNote = "";
      sync.step = 0;
      sync.lastOk = now();
      sync.notified = { warning: sync.notified.warning };
      if (job.done) job.done();
    } else {
      if (job.undo) job.undo(outcome);
      if (outcome !== "busy" && outcome !== "stop") {
        sync.failed = true;
        sync.lastFail = outcome;
      }
    }
    renderStatus();
    if (outcome === "ok") {
      pump();
    } else if (outcome === "busy") {
      waitThenPump(BUSY_RETRY_MS);
    } else if (outcome !== "stop") {
      waitThenPump(BACKOFF_MS[Math.min(sync.step, BACKOFF_MS.length - 1)]);
      sync.step += 1;
    }
    // "stop" (access code refused): nothing more until the producer reconnects.
    if (sync.kicked) {
      // The network came back (or the page was shown again) while this request was failing: try again now
      // instead of sitting out the back-off.
      sync.kicked = false;
      if (outcome !== "ok" && outcome !== "busy" && outcome !== "stop") kick();
    }
  }

  function waitThenPump(ms) {
    clearTimeout(sync.waitTimer);
    sync.waitTimer = setTimeout(() => {
      sync.waitTimer = 0;
      pump();
    }, ms);
  }

  // Try now, cutting a back-off short: the network is back, the page is visible again, the producer acted.
  function kick() {
    if (sync.busy) {
      sync.kicked = true; // finishJob() picks it up if the request under way fails
      return;
    }
    clearTimeout(sync.waitTimer);
    sync.waitTimer = 0;
    pump();
  }

  function scheduleSave() {
    clearTimeout(sync.saveTimer);
    sync.saveTimer = setTimeout(() => {
      sync.saveTimer = 0;
      sync.saveDue = true;
      pump();
    }, SAVE_DEBOUNCE_MS);
    renderStatus();
  }

  // 25 s while something happened in the last 10 minutes, then every minute, every 5 minutes after an idle hour.
  function pollDelay() {
    const idle = Date.now() - sync.activity;
    const base = Math.max(10, Number(config.pollSeconds) || 25) * 1000;
    if (idle < 10 * 60 * 1000) return base;
    if (idle < 60 * 60 * 1000) return Math.max(base, 60 * 1000);
    return Math.max(base, 5 * 60 * 1000);
  }

  function schedulePoll() {
    clearTimeout(sync.pollTimer);
    sync.pollTimer = setTimeout(() => {
      if (document.visibilityState !== "hidden") {
        followTheCalendar(); // a page left on screen all week moves on too; else the date marker may have turned over
        if (canSync()) {
          sync.wantLoad = true;
          // A page that stays on screen for hours still refreshes the Sheet's name, link and build now and then.
          if (Date.now() - sync.helloAt > HELLO_EVERY_MS) sync.wantHello = true;
          pump();
        }
      }
      schedulePoll();
    }, pollDelay());
  }

  // Leaving the page (or the app going to the background): get everything out, best effort.
  function flushOnHide() {
    flushTyping();
    releaseDeferred(); // nobody is typing in a hidden page: values held back for a focused field go in (and to storage)
    if (!show || !hasDirty(show) || !canSync()) return;
    clearTimeout(sync.saveTimer);
    sync.saveTimer = 0;
    sync.saveDue = true;
    if (!sync.busy) {
      kick();
      return;
    }
    // A request is under way and may not outlive the page: send the latest changes alongside it. Unless
    // that request already is exactly this save, sent to outlive the page (visibilitychange, then pagehide).
    const rec = show;
    const date = rec.date;
    const built = buildPatch(rec);
    const same = JSON.stringify(built.sent);
    if (sync.flights.some((flight) => flight.kept && flight.date === date && flight.sent === same)) return;
    const opts = { keepalive: true, light: rec.rev > 0 && !sync.fullOnly[date] };
    const epoch = sync.epoch;
    const sending = withLayoutOf(rec, () => request("save", { date: date, patch: built.patch, tv: template.tv, layout: layout() }, opts));
    const flight = takeOff(date, built.sent, opts);
    sending.then((reply) => {
      land(flight);
      if (reply.ok === true && epoch === sync.epoch) applySaveReply(date, reply, built.sent);
    }, () => land(flight));
  }

  function queueUnsavedShows() {
    storedDates().forEach((date) => {
      if (date !== show.date && sync.bgQ.indexOf(date) === -1 && sync.flushQ.indexOf(date) === -1 && !sync.parked[date] && hasDirty(readRecord(date))) sync.bgQ.push(date);
    });
  }

  // A fresh chance for the shows whose save failed earlier: on reconnecting, coming back to the page, at start.
  function retryParked() {
    sync.fails = {};
    sync.parked = {};
    queueUnsavedShows();
  }

  // A different Sheet (or web app) knows nothing about our revision numbers or about which prefills it holds.
  function forgetServerState() {
    storedDates().forEach((date) => {
      const rec = recordFor(date);
      rec.rev = 0;
      rec.pre = {};
      writeRecord(rec);
    });
    if (show) {
      show.rev = 0;
      show.pre = {};
    }
  }

  /* ------------------------------------------------------------------ status: pill, banner, announcements */

  let statusShown = "";
  let noticesShown = "";
  let alarmed = false; // a "not saving" state was announced and "back online" has not been said since

  // Where the changes are right now, as one of the PILL keys.
  function syncKey() {
    if (!endpoint()) return "local";
    if (!settings.connected) return "needcode";
    if (navigator.onLine === false) return "offline";
    // "Offline" is said only when the device has no network. A request that got no answer while the network
    // is up cannot be told from a blocked or redirected one; an answer that was not the Sheet's is trouble.
    if (sync.failed) return sync.lastFail === "offline" ? "unreachable" : "trouble";
    if (sync.rejected) return "trouble";
    if ((show && hasDirty(show)) || (sync.busy && sync.job === "save") || sync.flushQ.length || sync.bgQ.length) return "saving";
    if (Object.keys(sync.parked).length) return "behind";
    if (!sync.lastOk) return "connecting";
    return "ok";
  }

  function statusKey() {
    const key = syncKey();
    // Not getting through to the Sheet, and the browser refuses to store: say that nothing is being kept.
    return storageBroken && ["local", "needcode", "offline", "unreachable", "trouble"].indexOf(key) !== -1 ? "unsafe" : key;
  }

  // The lines of the banner at the top of the page: what the producer has to know or do about this device.
  function notices() {
    const list = [];
    const connected = canSync();
    const key = syncKey();
    if (storageBroken) {
      list.push({ tone: "bad", text: "This browser is NOT keeping changes on this device. Keep this page open and online until everything shows as saved." });
    }
    if (!connected) {
      list.push({ tone: "warn", text: "Not connected to Google Sheets" + (storageBroken ? "." : " — changes are saved on this device only.") });
    } else if (key === "trouble") {
      list.push({
        tone: "bad",
        text: "The Sheet is not saving" + (sync.failNote ? ": " + sync.failNote : "") + ". Changes are kept on this device"
          + (sync.rejected ? "." : " and sent again automatically.")
      });
    }
    const off = clockOff();
    if (off) {
      list.push({ tone: "warn", text: "This device's clock is about " + off + " off (or its time zone is wrong), so times recorded here will be wrong. Set its date and time to automatic." });
    }
    if (safariTab) {
      list.push({ tone: "mute", text: "iPhone / iPad: add this page to the Home Screen and use it from that icon. Safari forgets the access code and unsent changes after a week without a visit; the Home Screen app does not." });
    }
    return list;
  }

  function renderNotices() {
    const list = notices();
    dom.banner.hidden = list.length === 0;
    dom.bannerConnect.hidden = canSync();
    const shown = JSON.stringify(list);
    if (shown === noticesShown) return;
    noticesShown = shown;
    dom.bannerNotes.textContent = "";
    list.forEach((note) => {
      dom.bannerNotes.appendChild(el("p", { "data-tone": note.tone }, [el("span", { class: "sq", "aria-hidden": "true" }), document.createTextNode(note.text)]));
    });
  }

  function renderStatus() {
    const key = statusKey();
    const pill = PILL[key];
    const extra = key === "ok" ? " · " + core.to12h(core.hmFromMs(sync.lastOk)) : pill.extra;
    dom.pillText.textContent = pill.text;
    dom.pillExtra.textContent = extra;
    dom.syncPill.dataset.tone = pill.tone;
    dom.syncPill.setAttribute("aria-label", pill.text + extra + ". Connection settings");
    renderNotices();
    // The address comes from storage, which other pages on this host can write: only ever a Google Docs link.
    const sheetUrl = SHEET_URL_RE.test(str(cache.sheetUrl)) ? cache.sheetUrl : "";
    dom.openSheet.hidden = !sheetUrl;
    if (sheetUrl) dom.openSheet.setAttribute("href", sheetUrl);
    else dom.openSheet.removeAttribute("href");

    if (dom.dlgConnect.open) renderConnect();
    if (key === statusShown) return;
    // Screen readers hear the changes that matter, not every "saving…".
    if (pill.say) {
      say(pill.say);
      alarmed = true;
    } else if (key === "needcode" && statusShown) {
      say("Access code needed.");
    } else if (key === "ok" && alarmed) {
      say("Back online. Saved to the Sheet.");
      alarmed = false;
    }
    statusShown = key;
  }

  function say(message) {
    dom.live.textContent = "";
    setTimeout(() => {
      dom.live.textContent = message;
    }, 50);
  }

  // Toasts live in #toasts. A modal dialog is drawn above everything else on the page, so while one is open
  // they go into a holder inside it (and move back when it closes, see bindEvents).
  const dialogToasts = []; // { dialog, host }

  function toastHost() {
    const inDialog = dialogToasts.filter((entry) => entry.dialog.open && !entry.dialog.classList.contains("plain"))[0];
    return inDialog ? inDialog.host : $("toasts");
  }

  function showToast(node, ms) {
    const host = toastHost();
    if (!host) return;
    host.appendChild(node);
    setTimeout(() => node.classList.add("show"), 20);
    setTimeout(() => hideToast(node), ms);
  }

  function hideToast(node) {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 300);
  }

  function toast(message, tone) {
    showToast(el("div", { class: "toast" + (tone ? " " + tone : ""), role: tone === "bad" ? "alert" : "status", text: message }), tone === "bad" ? 7000 : 4000);
  }

  // "Cleared 7:24 PM  [Undo]": one at a time, the newest replaces the one before.
  let undoNode = null;

  function undoToast(message, restore) {
    if (undoNode) undoNode.remove();
    const button = el("button", { type: "button", text: "Undo" });
    const node = el("div", { class: "toast undo", role: "status" }, [el("span", { text: message }), button]);
    button.addEventListener("click", () => {
      hideToast(node);
      restore();
    });
    undoNode = node;
    showToast(node, UNDO_MS);
  }

  /* ------------------------------------------------------------------ opening a show */

  function openShow(date, manual) {
    if (!core.isValidDate(date)) return;
    // Coming back to a show the page would open by itself (arrows there and back, "This week's show")
    // hands the date back to the page: it follows the calendar again. That is the default show, and the
    // upcoming one too while last Friday's is still being finished.
    autoDate = !manual || date === defaultShowDate() || date === core.upcomingShowDate(new Date());
    lastTouch = Date.now();
    if (show && show.date === date) {
      rememberTab();
      renderDate();
      return;
    }
    if (show) {
      // Leave the old show cleanly: finish the field being typed in, then send what is unsaved first.
      const active = document.activeElement;
      if (active && active.dataset && active.dataset.field) active.blur();
      flushTyping();
      clearTimeout(sync.saveTimer);
      sync.saveTimer = 0;
      if (hasDirty(show) && sync.flushQ.indexOf(show.date) === -1) sync.flushQ.push(show.date);
    }
    deferred = Object.create(null);
    heldStamps = Object.create(null);
    issueReveal = 1;
    offWeekTold = "";
    sync.rejected = false;
    show = readRecord(date);
    refillPrefills(show, []);
    names = null;
    refreshNames();
    rememberTab();
    renderAll();
    growAll();
    sync.saveDue = hasDirty(show);
    sync.wantLoad = true;
    renderStatus();
    kick();
  }

  /*
   * A page left open since last week should not greet Friday with last week's show. Only when the page
   * chose the date itself and nobody has touched it for hours (no change, tap, key or scroll) — never
   * under a producer at work or reading. When it does move on it says so and goes back to the top, so
   * an empty checklist is not mistaken for lost ticks.
   */
  function followTheCalendar() {
    const next = defaultShowDate();
    const idle = Date.now() - Math.max(lastLocalChange, lastTouch);
    // Forward only: from the upcoming show ("Next show" was pressed) it never goes back to last Friday's.
    const ahead = show.date === core.upcomingShowDate(new Date());
    if (autoDate && show.date !== next && !ahead && !typingId() && idle > STALE_AFTER_MS) {
      if (reloadForNewWeek(next)) return;
      openShow(next, false);
      toast("Now showing " + core.formatShowDate(next) + " — the earlier show is under History");
      scrollToNode($("top"));
    } else {
      renderDate();
    }
  }

  /*
   * The page is about to move on to a new week by itself. A page left open all week (a pinned tab, the Home
   * Screen app) still runs the files it was loaded with, possibly weeks ago; this is the one moment it can
   * load itself again without anybody noticing, and so pick up a newer checklist. Only when that is safe and
   * can work: online, every show on this device saved, no dialog open, opened without a ?date= link, and not
   * if the tab already reloaded itself in the last hours (the note in sessionStorage is the guard against a
   * loop, and tells the reloaded page to say why it shows another show). Returns true when it reloads.
   */
  function reloadForNewWeek(next) {
    if (tabLink || navigator.onLine === false || !canSync() || anyUnsaved() || dom.dlgConnect.open || dom.dlgHistory.open) return false;
    if (typeof window.location.reload !== "function") return false;
    if (lastReload && Math.abs(Date.now() - lastReload) < STALE_AFTER_MS) return false;
    const at = Date.now();
    tabMemory.write({ date: next, manual: false, at: at, link: tabLink, reloaded: at, moved: true });
    if (tabMemory.read().reloaded !== at) return false; // sessionStorage is not kept here: nothing would stop a loop
    flushTyping();
    window.location.reload();
    return true;
  }

  /* ------------------------------------------------------------------ dialogs */

  function openDialog(dialog) {
    if (dialog.open) return;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.classList.add("plain");
      dialog.setAttribute("open", "");
    }
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") {
      if (dialog.open) dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  let connecting = false;
  let leaveTimer = 0; // running while "Disconnect" waits for its second tap

  // The message sits right under the field it is about (`about` = "url": the web app address; else the code),
  // where it is still in view above a phone keyboard.
  function connectMessage(text, fine, about) {
    const node = about === "url" ? dom.endpointMsg : dom.connectMsg;
    const other = about === "url" ? dom.connectMsg : dom.endpointMsg;
    node.textContent = text;
    node.classList.toggle("fine", !!fine);
    other.textContent = "";
  }

  const anyUnsaved = () => storedDates().some((date) => hasDirty(recordFor(date)));

  function renderConnect() {
    const connected = canSync();
    const sheet = cache.sheetName || "the Google Sheet";
    const key = connected ? syncKey() : "";
    const failing = key === "offline" || key === "unreachable" || key === "trouble";
    dom.connectTitle.textContent = connected ? "Settings" : "Connect";
    dom.btnConnect.textContent = connected ? "Save" : "Connect";
    dom.btnDisconnect.hidden = !connected;
    dom.btnDisconnect.textContent = leaveTimer ? "Tap again to disconnect" : "Disconnect";
    dom.btnErase.hidden = !connected || !leaveTimer;
    dom.btnErase.disabled = !leaveTimer || anyUnsaved();
    dom.adv.hidden = !!fixedEndpoint;
    dom.homeHint.hidden = !safariTab;
    // The stored code is never shown: anyone handed the phone could read it. Empty = keep the stored one.
    dom.inCode.setAttribute("placeholder", connected && settings.code ? "Saved on this device" : "");
    dom.connStatus.dataset.tone = failing ? (key === "trouble" ? "bad" : "warn") : connected ? "good" : endpoint() ? "bad" : "mute";
    if (!connected) dom.connText.textContent = endpoint() ? "Not connected — access code needed" : "Not connected — changes stay on this device";
    else if (key === "offline") dom.connText.textContent = "Connected to " + sheet + ", but this device is offline. Changes are kept here and sent when it is back.";
    else if (key === "unreachable") dom.connText.textContent = "Connected to " + sheet + ", but it cannot be reached right now. Changes are kept on this device and sent again automatically.";
    else if (key === "trouble") dom.connText.textContent = "Connected to " + sheet + ", but it is not saving" + (sync.failNote ? ": " + sync.failNote : "") + ". Changes are kept on this device.";
    else dom.connText.textContent = "Connected to " + sheet;
    // Which version of the Sheet's script answers (the "build" line of Code.gs): tells "saved but not deployed" apart.
    const build = connected ? str(cache.build) : "";
    dom.connBuild.textContent = build ? "Sheet script build " + build : "";
    dom.connBuild.hidden = !build;
  }

  function openConnect(message, focusCode) {
    if (!dom.dlgConnect.open) {
      dom.inCode.value = "";
      dom.inDevice.value = deviceName();
      dom.inEndpoint.value = str(settings.endpoint);
      if (!fixedEndpoint && !endpoint()) dom.adv.open = true;
    }
    connectMessage(message || "", false);
    renderConnect();
    openDialog(dom.dlgConnect);
    if (focusCode) dom.inCode.focus();
  }

  function submitConnect(event) {
    event.preventDefault();
    if (connecting) return;
    settings.device = oneLine(dom.inDevice.value, core.MAX_BY);

    let endpointChanged = false;
    if (!fixedEndpoint) {
      const typed = dom.inEndpoint.value.trim();
      if (typed && !validEndpoint(typed)) {
        dom.adv.open = true;
        connectMessage("That is not an Apps Script web app address. It must look like https://script.google.com/macros/s/…/exec", false, "url");
        dom.inEndpoint.focus();
        return;
      }
      endpointChanged = typed !== str(settings.endpoint);
      settings.endpoint = typed;
    }
    if (endpointChanged) settings.connected = false;
    saveSettings();
    layoutCache = null;

    // An empty field means "the code already saved on this device" (it is not shown, see renderConnect).
    const typedCode = dom.inCode.value.trim();
    const code = typedCode || str(settings.code);
    if (!endpoint()) {
      renderStatus();
      renderConnect();
      if (typedCode) {
        dom.adv.open = true;
        connectMessage("The web app address of the Sheet is missing. Paste it here first (the person who set up the Sheet has it).", false, "url");
        dom.inEndpoint.focus();
      } else {
        closeDialog(dom.dlgConnect);
        toast("Saved. Changes stay on this device.");
      }
      return;
    }

    // Validate the code with "hello" before it is stored; only then start loading and saving.
    connecting = true;
    dom.btnConnect.disabled = true;
    connectMessage("Checking…", true);
    request("hello", {}, { code: code }).then((reply) => {
      if (reply.ok === true) {
        const otherSheet = endpointChanged || (!!cache.sheetUrl && str(reply.sheetUrl) !== cache.sheetUrl);
        settings.code = code;
        settings.connected = true;
        saveSettings();
        if (otherSheet) forgetServerState();
        applyHello(reply);
        sync.failed = false;
        sync.lastFail = "";
        sync.failNote = "";
        sync.rejected = false;
        sync.step = 0;
        sync.lastOk = now();
        sync.wantLoad = true;
        sync.saveDue = hasDirty(show);
        retryParked();
        askToPersist();
        closeDialog(dom.dlgConnect);
        toast("Connected to " + (cache.sheetName || "the Google Sheet"));
        renderStatus();
        kick();
      } else if (reply.error === "bad_code") {
        // Nothing typed and nothing stored: the request still went out (it is how the Sheet is reached at all).
        connectMessage(typedCode ? "That access code is not correct." : "Enter the access code.", false);
        dom.inCode.focus();
        dom.inCode.select();
      } else {
        connectMessage(oneLine(reply.message, 200) || "The Sheet could not answer. Try again in a moment.", false);
      }
    }, (err) => {
      if (err && err.kind === "reply") {
        if (!fixedEndpoint) dom.adv.open = true;
        // With the address built into the page there is nothing here for the producer to check or change.
        connectMessage("That did not answer as the checklist's web app: " + str(err.message) + "."
          + (fixedEndpoint ? " Tell the person who set up the Sheet." : ""), false, fixedEndpoint ? "" : "url");
      } else {
        connectMessage(fixedEndpoint
          ? "Could not reach the Sheet. Check the connection and try again. If it keeps failing, the Sheet's web app may no longer be deployed for “Anyone”: tell the person who set up the Sheet."
          : "Could not reach the Sheet. Check the connection (and the web app address) and try again.", false);
      }
    }).catch(() => {
      connectMessage("Connecting did not finish. Try again.", false);
    }).then(() => {
      connecting = false;
      dom.btnConnect.disabled = false;
      renderConnect();
    });
  }

  function disconnect() {
    settings.code = "";
    settings.connected = false;
    saveSettings();
    clearTimeout(sync.waitTimer);
    sync.waitTimer = 0;
    dom.inCode.value = "";
    renderStatus();
    renderConnect();
    connectMessage("Disconnected. Changes stay on this device until you connect again.", true);
  }

  function disarmLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = 0;
  }

  // "Disconnect" wipes the stored access code, and sits one thumb away from "Save": it takes two taps.
  // The first also brings up "Disconnect + erase device" for a borrowed phone.
  function askDisconnect(erase) {
    if (!leaveTimer) {
      leaveTimer = setTimeout(() => {
        leaveTimer = 0;
        connectMessage("", false);
        renderConnect();
      }, CONFIRM_MS);
      renderConnect();
      connectMessage(dom.btnErase.disabled
        ? "Tap again to disconnect. (Erasing is off: a show on this device is not saved to the Sheet yet.)"
        : "Tap again to disconnect. “Disconnect + erase” also removes the shows, crew names and Sheet link kept on this device.", false);
      return;
    }
    disarmLeave();
    disconnect();
    if (erase) eraseDevice();
  }

  // Leaves nothing of the Sheet's on a device that was only borrowed: stored shows, crew names, the Sheet
  // link, the remembered values. Only offered while every stored show is saved (see renderConnect).
  function eraseDevice() {
    if (anyUnsaved()) return;
    const date = show.date;
    const manual = !autoDate;
    flushTyping();
    storedDates().forEach((stored) => store.remove(KEY.show + stored));
    store.remove(KEY.cache);
    store.remove(KEY.last);
    tabMemory.clear();
    Object.keys(cache).forEach((key) => delete cache[key]);
    cache.roster = {};
    cache.defaults = {};
    Object.keys(last).forEach((key) => delete last[key]);
    layoutCache = null;
    sync.flushQ = [];
    sync.bgQ = [];
    sync.fails = {};
    sync.parked = {};
    sync.epoch += 1; // an answer still on its way must not bring any of it back
    show = null;
    openShow(date, manual);
    connectMessage("Disconnected. The shows, crew names and Sheet link kept on this device were erased.", true);
  }

  // Ask the browser not to evict this site's storage when space runs short. Harmless where it is refused,
  // and no cure for Safari's seven-day rule (that is what the Home Screen hint is for).
  function askToPersist() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") navigator.storage.persist().then(() => undefined, () => undefined);
    } catch (err) {
      // not available here
    }
  }

  // The option list of the "final status" field: id -> { label, tone }.
  const statusOptions = (() => {
    const out = {};
    core.flatten(template).forEach((def) => {
      if (def.type === "choice" && def.sum === "finalStatus") (def.options || []).forEach((o) => { out[o.id] = o; });
    });
    return out;
  })();
  const statusFieldId = (() => {
    const def = core.flatten(template).filter((d) => d.type === "choice" && d.sum === "finalStatus")[0];
    return def ? def.id : "";
  })();

  function localShows() {
    const out = {};
    const add = (rec) => {
      const p = core.progress(template, rec.state);
      const status = statusFieldId ? str((own(rec.state, statusFieldId) || {}).v) : "";
      out[rec.date] = { date: rec.date, done: p.done, total: p.total, status: status, label: (own(statusOptions, status) || {}).label || "", local: true, unsaved: hasDirty(rec), remote: false };
    };
    storedDates().forEach((date) => add(recordFor(date)));
    if (show && worthKeeping(show)) add(show);
    return out;
  }

  function renderHistory(remote) {
    const items = localShows();
    (remote || []).forEach((entry) => {
      if (!isObj(entry) || !core.isValidDate(entry.date)) return;
      const mine = own(items, entry.date);
      if (mine) {
        mine.remote = true;
        return; // this device's copy is at least as fresh as the list
      }
      items[entry.date] = {
        date: entry.date, done: isNum(entry.checksDone) ? entry.checksDone : 0, total: isNum(entry.checksTotal) ? entry.checksTotal : 0,
        status: str(entry.finalStatus), label: oneLine(entry.finalStatusLabel, 60), local: false, unsaved: false, remote: true
      };
    });

    // The Sheet lists its newest shows only: an older show missing from a full list is not "device only".
    const full = !!remote && remote.length >= HISTORY_LIMIT;
    const oldestListed = full ? remote.map((entry) => str(isObj(entry) ? entry.date : "")).sort()[0] : "";
    const tag = (tone, text) => el("span", { class: "mono", "data-tone": tone }, [el("span", { class: "dot", "aria-hidden": "true" }), el("span", { text: text })]);

    dom.historyList.textContent = "";
    const dates = Object.keys(items).sort().reverse();
    dates.forEach((date) => {
      const item = items[date];
      const meta = el("span", { class: "meta" }, [el("span", { class: "mono", text: item.done + " / " + item.total })]);
      if (item.status) meta.appendChild(tag((own(statusOptions, item.status) || {}).tone || "mute", item.label || item.status));
      if (remote && !item.remote && date > oldestListed) meta.appendChild(tag("warn", "On this device only"));
      else if (item.unsaved) meta.appendChild(tag("warn", "Not saved to the Sheet yet"));
      const row = el("button", { type: "button", class: "show-row", "aria-current": date === show.date ? "true" : null },
        [el("span", { class: "when", text: core.formatShowDate(date) }), meta]);
      row.addEventListener("click", () => {
        closeDialog(dom.dlgHistory);
        openShow(date, true);
        scrollToNode($("top"));
      });
      dom.historyList.appendChild(el("li", null, [row]));
    });
    return dates.length;
  }

  function openHistory() {
    flushTyping();
    const onDevice = renderHistory(null) ? "Showing the shows stored on this device." : "No shows on this device yet.";
    openDialog(dom.dlgHistory);
    if (!canSync()) {
      dom.historyNote.textContent = onDevice + " Connect to see all shows from the Sheet.";
      return;
    }
    dom.historyNote.textContent = "Loading the list from the Sheet…";
    request("list", { limit: HISTORY_LIMIT }).then((reply) => {
      if (reply.ok !== true) {
        dom.historyNote.textContent = "The Sheet did not send its list. " + onDevice;
        return;
      }
      const total = renderHistory(Array.isArray(reply.shows) ? reply.shows : []);
      dom.historyNote.textContent = total ? "Pick a show to open it." : "No shows yet.";
    }, (err) => {
      dom.historyNote.textContent = (err && err.kind === "reply" ? "The Sheet did not send its list. " : "Could not reach the Sheet. ") + onDevice;
    });
  }

  /* ------------------------------------------------------------------ sticky bar: height and current section */

  function measureBar() {
    document.documentElement.style.setProperty("--bar-h", dom.bar.offsetHeight + "px");
  }

  let spied = null;
  let spyQueued = false;
  let jumpedTo = null; // the section whose chip was tapped last

  function spy() {
    spyQueued = false;
    // The bar is not sticky on a phone held sideways: scrolled out of view it marks no line of its own.
    const line = Math.max(0, dom.bar.getBoundingClientRect().bottom) + 40;
    let current = null;
    sectionsUI.forEach((s) => {
      if (s.node.getBoundingClientRect().top <= line) current = s;
    });
    // The last sections cannot reach the line when the page ends first. At the very bottom the section that
    // was asked for counts (if it is on screen), otherwise the last one.
    const root = document.documentElement;
    const atEnd = sectionsUI.length > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2 && root.scrollHeight > window.innerHeight;
    if (atEnd) {
      const askedTop = jumpedTo ? jumpedTo.node.getBoundingClientRect().top : -1;
      if (jumpedTo && askedTop > line && askedTop < window.innerHeight) current = jumpedTo;
      else if (jumpedTo !== current) current = sectionsUI[sectionsUI.length - 1];
    } else if (jumpedTo && current !== jumpedTo) {
      const top = jumpedTo.node.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight) jumpedTo = null; // scrolled away from it again
    }
    if (current === spied) return;
    spied = current;
    sectionsUI.forEach((s) => {
      if (s === current) s.chip.setAttribute("aria-current", "true");
      else s.chip.removeAttribute("aria-current");
    });
    // Keep the current chip in view inside its own scroller (this never scrolls the page). At the top of
    // the list the scroller goes back to its start, where the overall count sits.
    const box = dom.chips.getBoundingClientRect();
    const pad = parseFloat(window.getComputedStyle(dom.chips).paddingLeft) || 16;
    let left = null;
    if (!current || current === sectionsUI[0]) {
      if (dom.chips.scrollLeft > 0) left = 0;
    } else {
      const chip = current.chip.getBoundingClientRect();
      if (chip.left < box.left + pad || chip.right > box.right - pad) left = dom.chips.scrollLeft + chip.left - box.left - pad;
    }
    if (left !== null) dom.chips.scrollTo({ left: left, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  function queueSpy() {
    if (spyQueued) return;
    spyQueued = true;
    requestAnimationFrame(spy);
  }

  /* ------------------------------------------------------------------ events */

  function bindEvents() {
    // A date picked by hand stays inside what the Sheet accepts for a new show (shows opened from History are not bound).
    const lastDate = () => core.addDays(core.localDateStr(new Date()), DAYS_AHEAD);
    const pick = (date) => {
      if (date >= FIRST_SHOW && date <= lastDate()) {
        openShow(date, true);
        return true;
      }
      toast("A show can be dated from 2020 up to one year from today.");
      return false;
    };
    dom.dateInput.setAttribute("min", FIRST_SHOW);
    dom.dateInput.setAttribute("max", lastDate());
    dom.prevWeek.addEventListener("click", () => pick(core.addDays(show.date, -7)));
    dom.nextWeek.addEventListener("click", () => pick(core.addDays(show.date, 7)));
    dom.thisWeek.addEventListener("click", () => openShow(core.upcomingShowDate(new Date()), false));
    dom.dateInput.addEventListener("change", () => {
      // Cleared, half-typed or out of range: back to the open show.
      if (!core.isValidDate(dom.dateInput.value) || !pick(dom.dateInput.value)) dom.dateInput.value = show.date;
    });
    dom.dateInput.addEventListener("blur", () => {
      dom.dateInput.value = show.date;
    });
    dom.dateInput.addEventListener("click", () => {
      // Desktop browsers open the calendar only from the small icon; a click anywhere on the date should do.
      const fine = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
      if (!fine || typeof dom.dateInput.showPicker !== "function") return;
      try {
        dom.dateInput.showPicker();
      } catch (err) {
        // already open, or not allowed here: the input still works by keyboard
      }
    });

    dom.syncPill.addEventListener("click", () => openConnect("", false));
    dom.bannerConnect.addEventListener("click", () => openConnect("", false));
    dom.openSettings.addEventListener("click", () => openConnect("", false));
    dom.openHistory.addEventListener("click", openHistory);
    dom.connectForm.addEventListener("submit", submitConnect);
    dom.btnDisconnect.addEventListener("click", () => askDisconnect(false));
    dom.btnErase.addEventListener("click", () => askDisconnect(true));
    dom.print.addEventListener("click", () => {
      flushTyping();
      window.print();
    });

    [dom.dlgConnect, dom.dlgHistory].forEach((dialog) => {
      dialog.addEventListener("click", (event) => {
        // A click on the dimmed backdrop lands on the <dialog> itself.
        if (event.target === dialog || (event.target.closest && event.target.closest("[data-close]"))) closeDialog(dialog);
      });
      // Toasts raised while the dialog is open are shown inside it; the ones still up when it closes move back.
      const host = el("div", { class: "toasts" });
      dialog.appendChild(host);
      dialogToasts.push({ dialog: dialog, host: host });
      dialog.addEventListener("close", () => {
        Array.prototype.slice.call(host.children).forEach((node) => dom.toasts.appendChild(node));
        if (dialog === dom.dlgConnect) disarmLeave();
      });
    });
    document.addEventListener("keydown", (event) => {
      // Native dialogs close on Escape by themselves; this is for the fallback in older browsers.
      if (event.key !== "Escape") return;
      [dom.dlgConnect, dom.dlgHistory].forEach((dialog) => {
        if (dialog.classList.contains("plain")) closeDialog(dialog);
      });
    });

    window.addEventListener("online", () => {
      sync.wantLoad = true;
      if (canSync()) retryParked();
      renderStatus();
      kick();
    });
    window.addEventListener("offline", renderStatus);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushOnHide();
        return;
      }
      followTheCalendar();
      if (canSync()) {
        sync.wantLoad = true;
        if (Date.now() - sync.helloAt > HELLO_EVERY_MS) sync.wantHello = true;
        retryParked();
        kick();
      }
      schedulePoll();
    });
    // Somebody is using the page (see followTheCalendar).
    ["pointerdown", "keydown", "touchstart", "wheel"].forEach((type) => {
      window.addEventListener(type, () => {
        lastTouch = Date.now();
      }, { passive: true });
    });
    window.addEventListener("pagehide", () => {
      sync.unloading = true;
      flushOnHide();
    });
    window.addEventListener("pageshow", () => {
      sync.unloading = false;
    });

    // The same show open in another tab of this browser: take over its changes.
    window.addEventListener("storage", (event) => {
      if (event.key === KEY.settings) {
        settings = readObject(KEY.settings);
        renderStatus();
        kick();
        return;
      }
      if (!show || event.key !== KEY.show + show.date || !event.newValue) return;
      const other = readRecord(show.date);
      const changed = mergeFields(show, other.state, typingIds(), []);
      changed.forEach((id) => {
        if (own(other.dirty, id) !== undefined) show.dirty[id] = other.dirty[id];
      });
      if (changed.length) {
        renderProgress();
        renderIssues();
      }
    });

    window.addEventListener("scroll", queueSpy, { passive: true });
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        measureBar();
        growAll();
        queueSpy();
      }, 150);
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        measureBar();
        growAll();
      });
    }
    window.addEventListener("beforeprint", flushTyping);
  }

  /* ------------------------------------------------------------------ start */

  function start() {
    buildPage();
    bindEvents();
    pruneStoredShows();

    // Deep link ?date=YYYY-MM-DD opens that show; otherwise this week's.
    let wanted = "";
    try {
      wanted = new URLSearchParams(window.location.search).get("date") || "";
    } catch (err) {
      wanted = "";
    }
    tabLink = core.isValidDate(wanted) ? wanted : "";
    // A reload of this tab (or the phone restoring it) comes back to the show the producer had picked: one
    // chosen by hand, or the upcoming one when the default is still last Friday's. A deep link opened anew
    // wins, and after hours the page starts from its default again.
    const kept = tabMemory.read();
    lastReload = isNum(kept.reloaded) ? kept.reloaded : 0;
    const resume = (kept.manual === true || kept.date === core.upcomingShowDate(new Date())) && core.isValidDate(kept.date)
      && str(kept.link) === tabLink && isNum(kept.at) && Math.abs(Date.now() - kept.at) < STALE_AFTER_MS;
    if (resume) openShow(kept.date, true);
    else openShow(tabLink || defaultShowDate(), !!tabLink);
    // The page reloaded itself to move on to a new week (reloadForNewWeek): say so, as it would have without the reload.
    if (kept.moved === true) toast("Now showing " + core.formatShowDate(show.date) + " — the earlier show is under History");

    measureBar();
    queueSpy();
    if (canSync()) {
      sync.wantHello = true;
      retryParked();
      kick();
    }
    schedulePoll();
    renderStatus();

    // Offline start and installable page; only where service workers are allowed (https or this machine).
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
    if ("serviceWorker" in navigator && (window.location.protocol === "https:" || local)) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js").catch(() => undefined);
      });
    }
  }

  start();
})();
