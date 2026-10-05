/*
 * RABEH weekly show checklist — core logic (window.RabehCore, and module.exports under Node).
 *
 * Pure functions only: no DOM, no storage, no network and no clock. The current time always arrives
 * through arguments (ctx.now / ctx.hm, or a Date handed in), so every rule behaves the same on every
 * device and can be tested in Node (dev/test-core.js).
 *
 * Vocabulary (SPEC §1)
 *   state = { fieldId: value }       value = { v, t, a, u, by }
 *   v   the value — check: 0 | 1, time: "HH:MM" | "", text / notes: string, choice: option id | ""
 *   t   time shown next to a check / choice (the producer may edit it)
 *   a   time the system recorded by itself (tick, "Now" button, auto rule); never typed by hand
 *   u   ms of the last change on the server-aligned clock; 0 = prefill, lowest priority
 *   by  short device label
 *
 * States and templates passed in are never mutated; functions return new objects.
 * Classic script, ES2019 at most (it has to run on older tablets).
 */
(function (factory) {
  "use strict";
  var api = factory();
  if (typeof window !== "undefined") window.RabehCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(function () {
  "use strict";

  var FIELD_ID_RE = /^[a-z0-9_.]{1,64}$/;
  var HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  // Same limits the server enforces on a save: staying inside them here means a save is never rejected.
  var MAX_TEXT = 2000;
  var MAX_BY = 40;
  var MAX_LABEL = 200;

  // The header fields (location, live time, producer) form a section of their own in the Sheet.
  var HEADER_KEY = "hdr";
  var HEADER_TITLE = "SHOW DETAILS";

  var WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  var MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  var FRIDAY = 5;
  var SATURDAY = 6;
  var FINISH_DAYS = 3; // a show with open post-show checks stays the default until the end of the Monday after it

  var hasOwn = Object.prototype.hasOwnProperty;

  /* ------------------------------------------------------------------ small utilities */

  // Own-property read. Field ids such as "constructor" are legal, so a plain obj[key] could hand back
  // something inherited from Object.prototype.
  function own(obj, key) {
    return obj != null && hasOwn.call(obj, key) ? obj[key] : undefined;
  }

  function str(x) {
    return typeof x === "string" ? x : "";
  }

  function isFiniteNum(x) {
    return typeof x === "number" && isFinite(x);
  }

  function clip(s, max) {
    return s.length > max ? s.slice(0, max) : s;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  // Shallow copy of a state. "__proto__" is skipped: assigning it would swap the copy's prototype.
  function cloneState(state) {
    var out = {};
    if (state) {
      Object.keys(state).forEach(function (id) {
        if (id !== "__proto__") out[id] = state[id];
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ time helpers */

  function isHM(s) {
    return typeof s === "string" && HM_RE.test(s);
  }

  // Normalises what a time input may hand over ("7:05", "19:05", "19:05:30") to "HH:MM".
  // Returns "" for an empty value and null for anything that is not a time.
  function normHM(value) {
    if (value == null) return "";
    if (typeof value !== "string") return null;
    var s = value.trim();
    if (s === "") return "";
    var m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(s);
    if (!m) return null;
    var h = Number(m[1]);
    if (h > 23 || Number(m[2]) > 59) return null;
    return pad2(h) + ":" + m[2];
  }

  // Device-local wall-clock "HH:MM" of a timestamp.
  function hmFromMs(ms) {
    if (!isFiniteNum(ms)) return "";
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // "19:05" -> "7:05 PM"; "" for anything that is not a valid "HH:MM".
  function to12h(hm) {
    if (!isHM(hm)) return "";
    var h = Number(hm.slice(0, 2));
    return (h % 12 || 12) + ":" + hm.slice(3) + (h < 12 ? " AM" : " PM");
  }

  /* ------------------------------------------------------------------ date helpers */

  function utcDateStr(d) {
    var y = String(d.getUTCFullYear());
    while (y.length < 4) y = "0" + y;
    return y + "-" + pad2(d.getUTCMonth() + 1) + "-" + pad2(d.getUTCDate());
  }

  // "YYYY-MM-DD" -> Date at 00:00 UTC, or null when it is not a real calendar date.
  // Date.UTC rolls impossible dates over (31 Feb -> 3 Mar), so a real date is one that survives the round trip.
  function parseDate(dateStr) {
    var m = typeof dateStr === "string" ? DATE_RE.exec(dateStr) : null;
    if (!m) return null;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return utcDateStr(d) === dateStr ? d : null;
  }

  function isValidDate(dateStr) {
    return parseDate(dateStr) !== null;
  }

  // Calendar arithmetic in UTC, so daylight-saving changes can never skip or repeat a day.
  function addDays(dateStr, n) {
    var d = parseDate(dateStr);
    if (!d || !isFiniteNum(n)) return "";
    d.setUTCDate(d.getUTCDate() + Math.round(n));
    return utcDateStr(d);
  }

  // "2026-10-09" -> "FRI 09 OCT 2026"; "" for an invalid date.
  function formatShowDate(dateStr) {
    var d = parseDate(dateStr);
    if (!d) return "";
    return WEEKDAYS[d.getUTCDay()] + " " + pad2(d.getUTCDate()) + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
  }

  // Device-local calendar date of a Date as "YYYY-MM-DD".
  function localDateStr(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return "";
    return utcDateStr(new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())));
  }

  // The show the page opens on: today on a Friday; yesterday on a Saturday morning (the post-show checks
  // of a late show are still being filled in); otherwise the coming Friday. Device-local calendar.
  function upcomingShowDate(nowDate) {
    var today = localDateStr(nowDate);
    if (!today) return "";
    var day = nowDate.getDay();
    var delta;
    if (day === FRIDAY) delta = 0;
    else if (day === SATURDAY && nowDate.getHours() < 12) delta = -1;
    else delta = (FRIDAY - day + 7) % 7;
    return addDays(today, delta);
  }

  // True while a show that was worked on (any tick) still has post-show checks open. The post-show list is
  // the stampWhenAllChecked list of the field tagged sum "postShowAt".
  function postShowOpen(template, state) {
    var target = flatten(template).filter(function (def) {
      return def.sum === "postShowAt" && Array.isArray(def.stampWhenAllChecked) && def.stampWhenAllChecked.length > 0;
    })[0];
    if (!target || progress(template, state).done === 0) return false;
    return !target.stampWhenAllChecked.every(function (id) {
      return isTicked(own(state, id));
    });
  }

  /*
   * The show the page opens on by itself. Normally upcomingShowDate(). But hand-over is often finished the
   * day after: from Saturday noon (when upcomingShowDate moves on) until the end of Monday it stays on last
   * Friday's show while that show has ticks and unfinished post-show checks. It lets go by itself once they
   * are done or on Tuesday, and never applies on a show day.
   * `stateOf(date)` hands over the state this device holds for a date (nothing = no such show here).
   */
  function defaultShowDate(nowDate, template, stateOf) {
    var up = upcomingShowDate(nowDate);
    if (!up) return "";
    var today = localDateStr(nowDate);
    var prev = addDays(up, -7);
    if (up <= today || today > addDays(prev, FINISH_DAYS)) return up;
    var state = typeof stateOf === "function" ? stateOf(prev) : null;
    return state && typeof state === "object" && postShowOpen(template, state) ? prev : up;
  }

  /* ------------------------------------------------------------------ template */

  function isGroup(row) {
    return !!row && row.type === "group";
  }

  /*
   * The template in display order as one flat list:
   *   { k: "section", n, key, title }
   *   { k: "sub", label, fallback, slot, role, secKey }      (a group's sub-heading)
   *   { k: "field", def }
   * `def` is a copy of the template row plus where it sits: secKey, secTitle, secN and, inside a group,
   * groupLabel / groupFallback / slot / role. The header fields come first as section "hdr".
   */
  function outline(template) {
    var items = [];

    function addField(row, section, grp) {
      var def = Object.assign({}, row, { secKey: section.key, secTitle: section.title, secN: section.n });
      if (grp) {
        def.groupLabel = grp.label;
        if (grp.fallback !== undefined) def.groupFallback = grp.fallback;
        if (grp.slot !== undefined) def.slot = grp.slot;
        if (grp.role !== undefined) def.role = grp.role;
      }
      items.push({ k: "field", def: def });
    }

    function addRows(rows, section) {
      (rows || []).forEach(function (row) {
        if (!isGroup(row)) {
          addField(row, section, null);
          return;
        }
        items.push({ k: "sub", label: row.label, fallback: row.fallback, slot: row.slot, role: row.role, secKey: section.key });
        (row.rows || []).forEach(function (inner) {
          addField(inner, section, row);
        });
      });
    }

    var header = { n: "", key: HEADER_KEY, title: HEADER_TITLE };
    items.push({ k: "section", n: header.n, key: header.key, title: header.title });
    addRows(template.header, header);
    (template.sections || []).forEach(function (section) {
      items.push({ k: "section", n: section.n, key: section.key, title: section.title });
      addRows(section.rows, section);
    });
    return items;
  }

  // Ordered list of every field def (header first), see outline() for the def shape.
  function flatten(template) {
    return outline(template)
      .filter(function (item) { return item.k === "field"; })
      .map(function (item) { return item.def; });
  }

  // { fieldId: def } with no prototype, so byId[anyString] is either a def or undefined.
  function fieldById(template) {
    var byId = Object.create(null);
    flatten(template).forEach(function (def) {
      byId[def.id] = def;
    });
    return byId;
  }

  function rosterName(roster, key) {
    var name = own(roster, key);
    return typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  }

  /*
   * Replaces {roleKey} placeholders with the roster name, or with `fallback` when the roster has none.
   * With neither, the placeholder disappears together with the dash that joined it to the rest:
   *   "{director} — Director / Switcher" -> "Director / Switcher".
   * Names are inserted literally in a single pass (a name that looks like a placeholder is not expanded).
   */
  function resolveLabel(label, roster, fallback) {
    var text = label == null ? "" : String(label);
    if (text.indexOf("{") === -1) return text;
    var fb = typeof fallback === "string" ? fallback.trim() : "";
    var dropped = false;
    var resolved = text.replace(/(\s+[—–-]\s+)?\{([A-Za-z0-9_]+)\}(\s+[—–-]\s+)?/g, function (match, lead, key, trail) {
      var name = rosterName(roster, key) || fb;
      if (name) return (lead || "") + name + (trail || "");
      // Nothing to show: keep one separator only if the placeholder sat between two other parts.
      dropped = true;
      return lead && trail ? lead : "";
    });
    // Two neighbouring placeholders can still leave a dash dangling at either end once one is dropped.
    if (dropped) resolved = resolved.replace(/^\s*[—–-]\s+|\s+[—–-]\s*$/g, "");
    return resolved.replace(/\s+/g, " ").trim();
  }

  /*
   * The names that go into the labels of ONE show: the Sheet's roster, except where somebody typed another
   * name into that role's name field for this show (a stand-in). A name field is a text field whose prefill
   * comes from the roster (`default: "roster.<roleKey>"`). Only a value that was really entered counts
   * (u > 0); cleared by hand it gives "", so the label falls back to the role rather than naming a person
   * who is not there. Prefills (u = 0) never count: they are the roster already.
   */
  function rosterFor(template, roster, state) {
    var out = {};
    Object.keys(roster || {}).forEach(function (key) {
      if (key !== "__proto__") out[key] = rosterName(roster, key);
    });
    flatten(template).forEach(function (def) {
      var m = def.type === "text" && typeof def.default === "string" ? /^roster\.([A-Za-z0-9_]+)$/.exec(def.default) : null;
      if (!m || m[1] === "__proto__") return;
      var e = own(state, def.id);
      if (e && typeof e === "object" && isFiniteNum(e.u) && e.u > 0) out[m[1]] = str(e.v).replace(/\s+/g, " ").trim();
      else if (own(out, m[1]) === undefined) out[m[1]] = "";
    });
    return out;
  }

  /*
   * Rows for the Sheet (SPEC §5): { k: "section" | "sub" | "field", label, id?, type?, sec?, sum?, opt?, opts? }.
   * `opt` passes on a check's `optional` flag (see countsNow), so the Sheet counts the way the page does.
   * Labels are resolved against the roster and clipped to the server's 200-character limit (a long crew
   * name must not get the whole save rejected). `sec` is the plain section title, so the Activity log
   * can be filtered by section; the Sheet itself tells repeated labels apart (the six "Present" rows)
   * by putting the sub row above them in front: "vMix Operator — Present".
   */
  function buildLayout(template, roster) {
    var rows = [];
    outline(template).forEach(function (item) {
      if (item.k === "section") {
        rows.push({ k: "section", label: clip((item.n ? item.n + " " : "") + item.title, MAX_LABEL) });
        return;
      }
      if (item.k === "sub") {
        rows.push({ k: "sub", label: clip(resolveLabel(item.label, roster, item.fallback), MAX_LABEL) });
        return;
      }
      var def = item.def;
      var row = {
        k: "field",
        id: def.id,
        type: def.type,
        label: clip(resolveLabel(def.label, roster, def.fallback), MAX_LABEL),
        sec: clip(String(def.secTitle), MAX_LABEL)
      };
      if (def.sum) row.sum = def.sum;
      if (def.type === "check" && typeof def.optional === "string" && def.optional) row.opt = def.optional;
      if (def.type === "choice") {
        row.opts = {};
        (def.options || []).forEach(function (option) {
          row.opts[option.id] = clip(String(option.label), MAX_LABEL);
        });
      }
      rows.push(row);
    });
    return rows;
  }

  /* ------------------------------------------------------------------ values */

  function isTicked(value) {
    return !!value && (value.v === 1 || value.v === true);
  }

  // The value of a field with every key present and of the right type (missing keys read as empty).
  function valueOf(def, state) {
    var e = own(state, def.id) || {};
    return {
      v: def.type === "check" ? (isTicked(e) ? 1 : 0) : str(e.v),
      t: str(e.t),
      a: str(e.a),
      u: isFiniteNum(e.u) && e.u > 0 ? e.u : 0,
      by: str(e.by)
    };
  }

  // "Edited" = the system recorded a time and the time now shown is a different one (SPEC §1).
  function isEdited(def, value) {
    if (!value) return false;
    var a = str(value.a);
    var shown = def && def.type === "time" ? str(value.v) : str(value.t);
    return a !== "" && a !== shown;
  }

  function hasContent(def, value) {
    if (!value) return false;
    if (def.type === "check") return isTicked(value) || str(value.t) !== "";
    return str(value.v).trim() !== "" || str(value.t) !== "";
  }

  // True when any field of a template group holds something (an issue slot with content stays visible).
  function groupHasContent(group, state) {
    return ((group && group.rows) || []).some(function (row) {
      return hasContent(row, own(state, row.id));
    });
  }

  /* ------------------------------------------------------------------ actions */

  function normCtx(ctx) {
    var now = ctx && isFiniteNum(ctx.now) && ctx.now > 0 ? ctx.now : 0;
    var hm = ctx && isHM(ctx.hm) ? ctx.hm : now ? hmFromMs(now) : "";
    return { now: now, hm: hm, by: clip(str(ctx && ctx.by).trim(), MAX_BY) };
  }

  /*
   * Applies one user action and the auto rules that follow from it.
   *   action: { type: "toggle", id, on }        check: tick / untick (`on` omitted = flip)
   *           { type: "setTime", id, value }    edit `t` of a check / choice or `v` of a time field; never touches `a`
   *           { type: "stampNow", id }          time field: v = a = ctx.hm
   *           { type: "setValue", id, value }   text / notes (a time field is treated like setTime)
   *           { type: "choose", id, option }    choice: select; the selected option again (or "") clears
   *   ctx:    { now: ms, hm: "HH:MM", by }
   * Returns { state, changed: [fieldIds] }. Nothing changed (unknown field, wrong type, invalid time, same
   * value) => `changed` is empty and `state` is the object that was passed in.
   */
  function applyAction(state, template, action, ctx) {
    var base = state || {};
    var defs = flatten(template);
    var byId = Object.create(null);
    defs.forEach(function (d) {
      byId[d.id] = d;
    });
    var def = action && typeof action.id === "string" ? byId[action.id] : undefined;
    if (!def) return { state: base, changed: [] };

    var c = normCtx(ctx);
    var next = null; // copy of the state, made on the first write
    var changed = [];

    function cur(d) {
      return valueOf(d, next || base);
    }

    function write(d, fields) {
      var prevU = cur(d).u;
      if (!next) next = cloneState(base);
      // Normally u = ctx.now. If the stored value claims a later time (the other device's clock ran a
      // little ahead) step just past it, otherwise this change would lose the merge and be undone.
      fields.u = Math.max(c.now, prevU + 1);
      fields.by = c.by;
      next[d.id] = fields;
      if (changed.indexOf(d.id) === -1) changed.push(d.id);
    }

    // Each setter writes only when something differs, and reports whether it did.
    function setMarked(d, v, t, a) { // check / choice
      var e = cur(d);
      if (e.v === v && e.t === t && e.a === a) return false;
      write(d, { v: v, t: t, a: a });
      return true;
    }
    function setTimeField(d, v, a) {
      var e = cur(d);
      if (e.v === v && e.a === a) return false;
      write(d, { v: v, a: a });
      return true;
    }
    function setText(d, v) {
      if (cur(d).v === v) return false;
      write(d, { v: v });
      return true;
    }

    function stampIfEmpty(target) {
      if (c.hm && cur(target).v === "") setTimeField(target, c.hm, c.hm);
    }

    // stampWhenAllChecked: the tick that completes a list stamps its (still empty) time field.
    function afterTick(d) {
      defs.forEach(function (target) {
        var list = target.type === "time" ? target.stampWhenAllChecked : null;
        if (!list || list.indexOf(d.id) === -1) return;
        var allTicked = list.every(function (id) {
          return byId[id] && cur(byId[id]).v === 1;
        });
        if (allTicked) stampIfEmpty(target);
      });
    }

    // stampWhenFilled: a text field getting its first content stamps its (still empty) time field.
    function afterFilled(d) {
      defs.forEach(function (target) {
        if (target.type === "time" && target.stampWhenFilled === d.id) stampIfEmpty(target);
      });
    }

    function editTime(d, raw) {
      var hm = normHM(raw);
      if (hm === null) return; // not a time: ignore rather than store garbage
      var e = cur(d);
      if (d.type === "time") {
        setTimeField(d, hm, e.a);
      } else if (d.type === "choice") {
        setMarked(d, e.v, hm, e.a); // the time may be typed before an option is selected
      } else if (d.type === "check") {
        if (e.v === 1) setMarked(d, 1, hm, e.a);
        else if (d.timeAlways && hm !== "" && setMarked(d, 1, hm, "")) afterTick(d); // typing a time ticks the box
      }
    }

    var handlers = {
      toggle: function () {
        if (def.type !== "check") return;
        var ticked = cur(def).v === 1;
        var on = action.on == null ? !ticked : !!action.on;
        if (!on) setMarked(def, 0, "", "");
        else if (!ticked && setMarked(def, 1, c.hm, c.hm)) afterTick(def);
      },
      setTime: function () {
        editTime(def, action.value);
      },
      stampNow: function () {
        if (def.type === "time" && c.hm) setTimeField(def, c.hm, c.hm);
      },
      setValue: function () {
        if (def.type === "time") {
          editTime(def, action.value);
          return;
        }
        if (def.type !== "text" && def.type !== "notes") return;
        var before = cur(def).v;
        var value = clip(action.value == null ? "" : String(action.value), MAX_TEXT);
        if (setText(def, value) && before.trim() === "" && value.trim() !== "") afterFilled(def);
      },
      choose: function () {
        if (def.type !== "choice") return;
        var e = cur(def);
        var option = action.option == null ? "" : String(action.option);
        if (option === "" || option === e.v) {
          setMarked(def, "", "", ""); // tapping the selected option again clears it
          return;
        }
        var known = (def.options || []).some(function (o) {
          return o.id === option;
        });
        if (!known) return;
        // The time is stamped once; switching to another option keeps it (and whether it was edited).
        if (e.t === "") setMarked(def, option, c.hm, c.hm);
        else setMarked(def, option, e.t, e.a);
      }
    };

    var handler = own(handlers, action.type);
    if (handler) handler();

    return { state: next || base, changed: changed };
  }

  /* ------------------------------------------------------------------ merge */

  // A copy of a value object reduced to the known keys with valid content; null if it is not an object.
  function cleanValue(f) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    var out = {};
    if (f.v === 0 || f.v === 1) out.v = f.v;
    else if (typeof f.v === "boolean") out.v = f.v ? 1 : 0;
    else if (typeof f.v === "string") out.v = clip(f.v, MAX_TEXT);
    if (typeof f.t === "string") out.t = isHM(f.t) ? f.t : "";
    if (typeof f.a === "string") out.a = isHM(f.a) ? f.a : "";
    out.u = isFiniteNum(f.u) && f.u > 0 ? f.u : 0;
    if (typeof f.by === "string") out.by = clip(f.by, MAX_BY);
    return out;
  }

  /*
   * Field-level last-writer-wins, identical on client and server (SPEC §1):
   * the incoming value f replaces the existing e  iff  !e || f.u > e.u.
   * So a prefill (u = 0) fills a field that is absent and never replaces anything.
   * `skipIds` (optional array) lists fields to leave alone, e.g. the one being typed in.
   * Returns { state, changed: [ids accepted] }; `state` is the local object itself when nothing was accepted.
   */
  function merge(localState, incomingState, skipIds) {
    var local = localState || {};
    var skip = Array.isArray(skipIds) ? skipIds : [];
    var out = null;
    var changed = [];
    Object.keys(incomingState || {}).forEach(function (id) {
      if (id === "__proto__" || !FIELD_ID_RE.test(id) || skip.indexOf(id) !== -1) return;
      var f = cleanValue(incomingState[id]);
      if (!f) return;
      var e = own(out || local, id);
      if (e && typeof e === "object") {
        var existingU = isFiniteNum(e.u) && e.u > 0 ? e.u : 0;
        if (!(f.u > existingU)) return;
      }
      if (!out) out = cloneState(local);
      out[id] = f;
      changed.push(id);
    });
    return { state: out || local, changed: changed };
  }

  /*
   * stampWhenAllChecked after a merge. applyAction stamps a list's time on the device that makes the
   * completing tick, against what that device holds. When the checks are split across devices nobody makes
   * that tick against a complete list, so the rule is evaluated again after a merge. Returns the targets to
   * stamp, [{ id, hm }], for every list where
   *   - the merge changed at least one of its checks (`changedIds`),
   *   - every check of the list is now ticked, and
   *   - the target was never written (absent, or an empty u = 0 entry). A time cleared by hand (u > 0, "")
   *     is left alone.
   * hm is the recorded time of the completing check: the listed check with the highest u (its auto time
   * `a`, else its shown time `t`). Not the clock, so every device derives the same value and an old show
   * opened later is not stamped with today's time.
   */
  function stampsDue(template, state, changedIds) {
    var changed = Array.isArray(changedIds) ? changedIds : [];
    var due = [];
    if (!changed.length) return due;
    flatten(template).forEach(function (target) {
      var list = target.type === "time" && Array.isArray(target.stampWhenAllChecked) ? target.stampWhenAllChecked : [];
      if (!list.length) return;
      var touched = list.some(function (id) {
        return changed.indexOf(id) !== -1;
      });
      if (!touched) return;
      var current = own(state, target.id);
      if (current && typeof current === "object" && ((isFiniteNum(current.u) && current.u > 0) || str(current.v) !== "")) return;
      var last = null;
      var allTicked = list.every(function (id) {
        var e = own(state, id);
        if (!isTicked(e)) return false;
        var u = isFiniteNum(e.u) && e.u > 0 ? e.u : 0;
        if (!last || u > last.u) last = { u: u, hm: isHM(e.a) ? e.a : isHM(e.t) ? e.t : "" };
        return true;
      });
      if (allTicked && last && last.hm) due.push({ id: target.id, hm: last.hm });
    });
    return due;
  }

  /* ------------------------------------------------------------------ prefills */

  // A candidate prefill as stored text: "" unless it is usable for this field type.
  function prefillValue(def, raw) {
    if (raw && typeof raw === "object") raw = raw.v; // a value object is accepted as well as a bare value
    if (typeof raw === "number" && isFinite(raw)) raw = String(raw);
    if (typeof raw !== "string") return "";
    if (def.type === "time") return normHM(raw) || "";
    if (def.type === "text" || def.type === "notes") return clip(raw.trim(), MAX_TEXT);
    return "";
  }

  /*
   * The prefilled state of a new show: { id: { v, u: 0 } } for every field that has a prefill.
   *   roster   = { producer, vmix, director, audio, camera, station, other }
   *   defaults = { location, liveTime, crewCall, recordingStart }
   *   last     = { fieldId: value } remembered from the previous show on this device (see rememberFrom);
   *              it wins over `defaults`, and only for the fields flagged `remember` in the template.
   * u = 0 marks these as prefills: they lose a merge against any real value.
   */
  function defaultsFor(template, roster, defaults, last) {
    var sources = { roster: roster, defaults: defaults };
    var out = {};
    flatten(template).forEach(function (def) {
      var value = def.remember ? prefillValue(def, own(last, def.id)) : "";
      if (value === "" && typeof def.default === "string") {
        var path = def.default.split("."); // "defaults.location" | "roster.vmix"
        value = prefillValue(def, own(own(sources, path[0]), path[1]));
      }
      if (value !== "") out[def.id] = { v: value, u: 0 };
    });
    return out;
  }

  // The values worth remembering for the next show: { fieldId: v } for non-empty `remember` fields.
  function rememberFrom(template, state) {
    var out = {};
    flatten(template).forEach(function (def) {
      if (!def.remember) return;
      var value = prefillValue(def, own(state, def.id));
      if (value !== "") out[def.id] = value;
    });
    return out;
  }

  /* ------------------------------------------------------------------ progress */

  /*
   * Is this check part of the count right now? Every check is, except one flagged `optional` (the spare crew
   * slot): that one counts only once it is used — ticked, or the text field it names filled in. Otherwise a
   * full house would read "5 / 6" every week and the count could only be completed by ticking nobody present.
   * The Sheet applies the same rule (Code.gs countsNow) through `opt` on the layout row.
   */
  function countsNow(def, state) {
    if (!def || def.type !== "check") return false;
    if (typeof def.optional !== "string" || def.optional === "") return true;
    if (isTicked(own(state, def.id))) return true;
    var other = own(state, def.optional);
    return !!other && typeof other === "object" && str(other.v).trim() !== "";
  }

  // { done, total, sections: { key: { done, total } } } — counts `check` fields only (see countsNow).
  function progress(template, state) {
    var result = { done: 0, total: 0, sections: {} };
    (template.sections || []).forEach(function (section) {
      result.sections[section.key] = { done: 0, total: 0 };
    });
    flatten(template).forEach(function (def) {
      if (!countsNow(def, state)) return;
      var ticked = isTicked(own(state, def.id)) ? 1 : 0;
      result.total += 1;
      result.done += ticked;
      var sec = own(result.sections, def.secKey);
      if (sec) {
        sec.total += 1;
        sec.done += ticked;
      }
    });
    return result;
  }

  return {
    // template
    outline: outline,
    flatten: flatten,
    fieldById: fieldById,
    resolveLabel: resolveLabel,
    rosterFor: rosterFor,
    buildLayout: buildLayout,
    // state
    applyAction: applyAction,
    merge: merge,
    stampsDue: stampsDue,
    defaultsFor: defaultsFor,
    rememberFrom: rememberFrom,
    progress: progress,
    countsNow: countsNow,
    valueOf: valueOf,
    isTicked: isTicked,
    isEdited: isEdited,
    hasContent: hasContent,
    groupHasContent: groupHasContent,
    // times and dates
    hmFromMs: hmFromMs,
    to12h: to12h,
    isHM: isHM,
    normHM: normHM,
    upcomingShowDate: upcomingShowDate,
    defaultShowDate: defaultShowDate,
    postShowOpen: postShowOpen,
    formatShowDate: formatShowDate,
    addDays: addDays,
    isValidDate: isValidDate,
    localDateStr: localDateStr,
    // constants
    FIELD_ID_RE: FIELD_ID_RE,
    HEADER_KEY: HEADER_KEY,
    HEADER_TITLE: HEADER_TITLE,
    MAX_TEXT: MAX_TEXT,
    MAX_BY: MAX_BY,
    MAX_LABEL: MAX_LABEL
  };
});
