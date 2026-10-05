/*
 * RABEH weekly show checklist — the template.
 *
 * This file is the single description of what is on the checklist: every section, row, label and
 * auto-time rule. The page (app.js) renders from it, core.js applies its rules, and the Google Sheet
 * is laid out from it (RabehCore.buildLayout).
 *
 * PUBLIC FILE — it must never contain a person's name. Crew names live in the Sheet's "Crew" tab and
 * are dropped into labels at runtime through {roleKey} placeholders (see `roles` for the keys).
 *
 * Shape
 *   template = { tv, show, title, tagline, roles, header: [field…], sections: [section…] }
 *   section  = { n: "01", key: "gfx", title: "GRAPHICS", rows: [field | group…], addLabel? }
 *   group    = { type: "group", label, fallback?, role?, slot?, rows: [field…] }   (a sub-heading + its rows)
 *   field    = { id, type: "check" | "time" | "text" | "notes" | "choice", label, …flags }
 *
 * Field flags
 *   fallback             what a {roleKey} placeholder in `label` shows when the roster has no name.
 *                        "" (or absent) drops the placeholder together with its " — " separator.
 *   default              where the prefill comes from: "defaults.<key>" or "roster.<roleKey>".
 *   remember             prefill from the value used for the previous show on this device (wins over `default`).
 *   sum                  tag the server uses to build the "Shows" summary row.
 *   now                  time field with a "Now" button.
 *   timeLabel            caption of the time attached to a check / choice.
 *   timeAlways           check whose time input is always visible; typing a time ticks the box.
 *   optional             check that only counts once it is used: it is left out of "Checks done" while it is
 *                        unticked and the text field named here (a field id) is empty. For a slot that is
 *                        usually nobody's, so that a full house reads as complete.
 *   stampWhenAllChecked  time field stamped when the last of these checks is ticked (only while empty).
 *   stampWhenFilled      time field stamped when that text field first gets content (only while empty).
 *   options              choice options: [{ id, label, tone: "good" | "warn" | "bad" }].
 *
 * Bump `tv` whenever rows are added, removed, renamed or re-ordered (the Sheet layout follows it).
 */
(function () {
  "use strict";

  var roles = {
    producer: "Producer",
    vmix: "vMix Operator",
    director: "Director / Switcher",
    audio: "Audio Engineer",
    camera: "Camera Operator",
    station: "Station Master",
    other: "Other Crew"
  };

  // Order of the crew blocks in section 02.
  var crewOrder = ["vmix", "director", "audio", "camera", "station", "other"];

  var ISSUES_NOTES = "Issues / notes";

  function field(type, id, label, flags) {
    return Object.assign({ id: id, type: type, label: label }, flags || {});
  }
  function check(id, label, flags) { return field("check", id, label, flags); }
  function time(id, label, flags) { return field("time", id, label, flags); }
  function text(id, label, flags) { return field("text", id, label, flags); }
  function notes(id, label, flags) { return field("notes", id, label, flags); }
  function group(label, rows, flags) {
    return Object.assign({ type: "group", label: label, rows: rows }, flags || {});
  }

  // Ids of every check in a list of rows (looking inside groups), in display order.
  function checkIds(rows) {
    var ids = [];
    rows.forEach(function (row) {
      if (row.type === "group") ids = ids.concat(checkIds(row.rows));
      else if (row.type === "check") ids.push(row.id);
    });
    return ids;
  }

  // The spare slot at the end of the crew list: most weeks nobody is in it.
  var spareCrew = "other";

  function crewBlock(key) {
    var nameId = "crew." + key + ".name";
    var present = { timeLabel: "Arrival time", timeAlways: true, sum: "crewPresent" };
    if (key === spareCrew) present.optional = nameId; // counts once somebody is named or ticked present
    return group(roles[key], [
      text(nameId, "Name", { default: "roster." + key }),
      check("crew." + key + ".present", "Present", present)
    ], { role: key });
  }

  function emceeSection(n, key, title) {
    return {
      n: n,
      key: key,
      title: title,
      rows: [
        text(key + ".name", "Name", { remember: true }),
        time(key + ".sched_mic", "Scheduled mic time", { remember: true }),
        time(key + ".actual_mic", "Actual mic fitted time", { now: true }),
        time(key + ".sched_onset", "Scheduled on-set time", { remember: true }),
        time(key + ".actual_onset", "Actual on-set time", { now: true }),
        check(key + ".mic_tested", "Microphone tested"),
        check(key + ".ready", "Emcee ready for show")
      ]
    };
  }

  function issueSlot(n) {
    var p = "iss." + n + ".";
    return group("Issue " + n, [
      notes(p + "issue", "Issue", { sum: "issues" }),
      text(p + "owner", "Department / person responsible"),
      notes(p + "action", "Action taken"),
      time(p + "flagged_at", "Flagged at", { now: true, stampWhenFilled: p + "issue" }),
      time(p + "resolved_at", "Resolved at", { now: true })
    ], { slot: n });
  }

  // 08 — who confirms which recording. The "confirmed at" time below is stamped from these ten checks.
  var recordingGroups = [
    group("{vmix} — vMix", [
      check("rec.vmix.started", "Recording started"),
      check("rec.vmix.running", "Recording running correctly"),
      check("rec.vmix.save_location", "Save location confirmed"),
      check("rec.vmix.storage", "Available storage confirmed")
    ], { fallback: "vMix Operator" }),
    // fallback "": without a name these two headings are just the role title.
    group("{director} — Director / Switcher", [
      check("rec.dir.pgm_output", "Recording / programme output confirmed"),
      check("rec.dir.switcher", "Switcher recording")
    ], { fallback: "" }),
    group("{audio} — Audio Engineer", [
      check("rec.aud.external", "Audio being recorded correctly in external recorder")
    ], { fallback: "" }),
    group("Camera Operator", [
      check("rec.cam.started", "Camera recording started"),
      check("rec.cam.indicator", "Recording indicator confirmed"),
      check("rec.cam.storage", "Available card / storage space confirmed")
    ])
  ];

  var postChecks = [
    check("post.pgm_saved", "Complete vMix PGM recording saved"),
    check("post.clean_pgm", "Recording clean PGM playback checked"),
    check("post.cam_recordings", "Camera recordings confirmed"),
    check("post.audio_recordings", "Audio recordings confirmed"),
    check("post.handover", "Files handed over / backed up")
  ];

  var template = {
    tv: 1,
    show: "RABEH",
    title: "Weekly Show Checklist",
    tagline: "Live production / Recording / Post-show",
    roles: roles,

    // Shown at the top of the page next to the show date.
    header: [
      text("hdr.location", "Location", { default: "defaults.location", sum: "location", remember: true }),
      time("hdr.live_time", "Live time", { default: "defaults.liveTime", sum: "liveTime", remember: true }),
      text("hdr.producer", "Producer", { default: "roster.producer", sum: "producer" })
    ],

    sections: [
      {
        n: "01",
        key: "gfx",
        title: "GRAPHICS",
        rows: [
          check("gfx.new_loaded", "Any new or updated graphics loaded into vMix"),
          check("gfx.all_tested", "All graphics tested before show"),
          check("gfx.lower_thirds", "Names / lower thirds checked"),
          check("gfx.countdown", "Countdown graphics checked"),
          check("gfx.script", "Script checked"),
          check("gfx.playback", "Playback videos checked"),
          check("gfx.winner_prize", "Winner / prize graphics checked"),
          check("gfx.qr_cta", "QR / CTA graphics checked"),
          notes("gfx.notes", ISSUES_NOTES)
        ]
      },
      {
        n: "02",
        key: "crew",
        title: "CREW ARRIVAL & ATTENDANCE",
        rows: [time("crew.call_time", "Crew call time", { default: "defaults.crewCall", remember: true })]
          .concat(crewOrder.map(crewBlock))
          .concat([notes("crew.late_missing", "Late / missing crew", { sum: "lateMissing" })])
      },
      {
        n: "03",
        key: "cam",
        title: "CAMERAS",
        rows: [
          check("cam.powered", "All cameras powered and ready"),
          check("cam.framing", "Camera framing checked"),
          check("cam.feeds", "Camera feeds visible correctly"),
          check("cam.exposure_wb", "Exposure / white balance checked"),
          check("cam.focus", "Focus checked"),
          check("cam.media", "Recording media / storage checked"),
          check("cam.power", "Camera batteries / power checked"),
          notes("cam.notes", ISSUES_NOTES)
        ]
      },
      {
        n: "04",
        key: "sw",
        title: "CAMERA SWITCHING & CREW COMMUNICATION",
        rows: [
          check("sw.tested", "Camera switching tested with {director}", { fallback: "the Director" }),
          check("sw.positions", "Camera operators understand their positions / shots"),
          check("sw.special", "Any special shots or movements discussed"),
          notes("sw.notes", ISSUES_NOTES)
        ]
      },
      {
        n: "05",
        key: "aud",
        title: "AUDIO",
        rows: [
          check("aud.emcee_mics", "Emcee microphones tested"),
          check("aud.phone", "Phone call checked"),
          check("aud.mic_batteries", "Microphone batteries checked"),
          check("aud.backup_batteries", "Backup batteries available"),
          check("aud.levels", "Audio levels checked"),
          check("aud.confirmed", "{audio} confirms audio ready", { fallback: "Audio Engineer" }),
          notes("aud.notes", ISSUES_NOTES)
        ]
      },
      emceeSection("06", "em1", "EMCEE 1"),
      emceeSection("07", "em2", "EMCEE 2"),
      {
        n: "08",
        key: "rec",
        title: "SHOW RECORDING CONFIRMATION",
        rows: [time("rec.start_time", "Recording start time", { default: "defaults.recordingStart" })]
          .concat(recordingGroups)
          .concat([
            time("rec.all_confirmed_at", "All recording systems confirmed at", {
              now: true,
              stampWhenAllChecked: checkIds(recordingGroups)
            })
          ])
      },
      {
        n: "09",
        key: "fin",
        title: "FINAL DEPARTMENT READINESS",
        rows: [
          check("fin.vmix_gfx", "vMix / Graphics — READY"),
          check("fin.director", "Director / Switcher — READY"),
          check("fin.cameras", "Cameras — READY"),
          check("fin.audio", "Audio — READY"),
          check("fin.emcees", "Emcees — READY"),
          check("fin.recording", "Recording — READY"),
          field("choice", "fin.status", "Final status", {
            timeLabel: "Final readiness confirmed at",
            sum: "finalStatus",
            options: [
              { id: "ready", label: "READY FOR LIVE", tone: "good" },
              { id: "ready_issue", label: "READY WITH OUTSTANDING ISSUE", tone: "warn" },
              { id: "not_ready", label: "NOT READY", tone: "bad" }
            ]
          })
        ]
      },
      {
        n: "10",
        key: "iss",
        title: "OUTSTANDING ISSUES",
        // Slot 1 is always shown; this button reveals the next one. A slot with content is always shown.
        addLabel: "+ Add another issue",
        rows: [issueSlot(1), issueSlot(2), issueSlot(3)]
      },
      {
        n: "11",
        key: "post",
        title: "POST-SHOW",
        rows: postChecks.concat([
          time("post.completed_at", "Post-show check completed at", {
            now: true,
            sum: "postShowAt",
            stampWhenAllChecked: checkIds(postChecks)
          })
        ])
      }
    ]
  };

  if (typeof window !== "undefined") window.RABEH_TEMPLATE = template;
  if (typeof module !== "undefined" && module.exports) module.exports = template;
})();
