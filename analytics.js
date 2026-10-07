/**
 * Eye on the Sky — analytics.js
 * Módulo COMPARTIDO entre el editor del estudiante (index.html) y el panel docente
 * (dashboard.html). Calcula métricas y alertas a partir del proyecto (.json) con las
 * mismas reglas en ambos lados: lo que el estudiante ve en su panel "Actividad y Salud"
 * es exactamente lo que verá el docente.
 *
 * Principios:
 *  1. PROCEDENCIA SOBRE EL TEXTO FINAL: la salud se mide sobre lo que quedó en el
 *     documento (cada fragmento lleva una marca de origen), no sobre contadores de
 *     eventos. Pegar y luego borrar no penaliza; escribir y luego borrar no suma.
 *  2. PEGADOS DECLARADOS: cualquier pegado grande, en cualquier momento, puede
 *     declararse (notas propias, cita textual de una fuente, texto generado con IA).
 *     Lo declarado no se castiga, pero se reporta y tiene un presupuesto (POLICY).
 *  3. PROCESO DE ESCRITURA: tasa de revisión, ediciones no lineales y pausas permiten
 *     distinguir composición genuina de transcripción (copiar a mano un texto ajeno).
 *  4. Todo es INDICIO para conversar con el estudiante, no prueba. El cliente es
 *     manipulable por un estudiante con conocimientos técnicos.
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------
     POLÍTICA DEL CURSO (el docente puede ajustar estos valores)
     ------------------------------------------------------------------ */
  const POLICY = {
    PASTE_DECLARE_MIN_WORDS: 12,     // pegados con ≥ N palabras piden declaración
    NOTES_MAX_SHARE:   0.35,         // notas/borradores propios declarados: máx. 35 % del documento
    QUOTES_MAX_SHARE:  0.15,         // citas textuales declaradas: máx. 15 %
    AI_MAX_SHARE:      0.10,         // texto con IA declarado: máx. 10 %
    UNDECLARED_WARN:   0.08,         // pegado sin declarar ≥ 8 % → advertencia
    UNDECLARED_DANGER: 0.20,         // ≥ 20 % → alerta crítica
    TYPED_WARN:        0.60,         // texto tecleado < 60 % → barra en ámbar
    TYPED_DANGER:      0.40,         // < 40 % → barra en rojo y advertencia (con ≥ 150 palabras)
    BIO_OK:   75,                    // consistencia biométrica ≥ 75 % → autor confirmado
    BIO_WARN: 60,                    // 60–74 % divergente, < 60 % crítico
    BIO_MIN_SAMPLES: 25,             // muestras mínimas por sesión para evaluar
    BIO_BASELINE_SAMPLES: 250,       // pulsaciones para calibrar la huella
    SESSION_RESUME_MINUTES: 30,      // recargar dentro de 30 min en el mismo dispositivo = misma sesión
    BURST_WORDS: 400,                // salto atípico: > 400 palabras netas…
    BURST_WPM: 65,                   // …a más de 65 palabras/minuto
    TRANSCRIPTION_MIN_CHARS: 3000,   // patrón de transcripción: solo se evalúa con ≥ 3000 car. tecleados
    TRANSCRIPTION_REVISION_MAX: 0.04,// tasa de revisión < 4 % (casi sin borrar)…
    TRANSCRIPTION_NONLINEAR_MAX: 1.0,// …y < 1 edición no lineal por cada 1000 car.
  };

  /* ------------------------------------------------------------------
     PROCEDENCIA: colores de fondo que marcan el origen de cada fragmento
     ------------------------------------------------------------------ */
  const PROVENANCE = {
    typed:    { label: 'Tecleado',             bg: null,                         rgb: null },
    notes:    { label: 'Notas propias (decl.)',bg: 'rgba(74, 108, 247, 0.16)',   rgb: '74,108,247' },
    quote:    { label: 'Cita textual (decl.)', bg: 'rgba(16, 185, 129, 0.18)',   rgb: '16,185,129' },
    ai:       { label: 'IA declarada',         bg: 'rgba(245, 158, 11, 0.24)',   rgb: '245,158,11' },
    paste:    { label: 'Pegado sin declarar',  bg: 'rgba(229, 57, 53, 0.18)',    rgb: '229,57,53' },
    citation: { label: 'Referencia (cita)',    bg: 'rgba(139, 92, 246, 0.20)',   rgb: '139,92,246' },
  };
  const PASTE_KINDS = ['notes', 'quote', 'ai', 'paste'];

  function classifyBackground(bg) {
    if (!bg || typeof bg !== 'string') return 'typed';
    const v = bg.replace(/\s+/g, '');
    for (const [kind, def] of Object.entries(PROVENANCE)) {
      if (def.rgb && v.includes(def.rgb)) return kind;
    }
    return 'typed'; // cualquier otro color (resaltado del propio estudiante)
  }
  function isProvenanceBackground(bg) { return classifyBackground(bg) !== 'typed'; }

  /** Tipo de un evento de pegado (compatibilidad con archivos antiguos). */
  function pasteKind(ev) {
    if (!ev) return 'paste';
    if (ev.kind && PASTE_KINDS.includes(ev.kind)) return ev.kind;
    if (ev.is_initial) return 'notes'; // el antiguo "pegado inicial exento" = notas propias
    return 'paste';
  }

  /* ------------------------------------------------------------------
     UTILIDADES
     ------------------------------------------------------------------ */
  function countWords(text) {
    return (text || '').trim().split(/\s+/).filter(w => w.length > 0).length;
  }
  function htmlToText(html) {
    if (!html) return '';
    if (typeof document !== 'undefined') {
      const d = document.createElement('div');
      d.innerHTML = html;
      return d.textContent || '';
    }
    return String(html).replace(/<[^>]+>/g, ' ');
  }
  function tableTextFromEmbed(value) {
    const html = (value && (value.html || (typeof value === 'string' ? value : ''))) || '';
    // Solo celdas (se omiten los botones de control de la tabla)
    const cells = html.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [];
    return cells.map(c => htmlToText(c)).join(' ');
  }

  /** Texto del documento (incluye celdas de tablas) a partir del delta o, si no hay, del HTML. */
  function documentText(project) {
    const ops = project?.content?.delta?.ops;
    if (Array.isArray(ops) && ops.length) {
      let t = '';
      for (const op of ops) {
        if (typeof op.insert === 'string') t += op.insert;
        else if (op.insert && op.insert['academic-table']) t += ' ' + tableTextFromEmbed(op.insert['academic-table']) + '\n';
      }
      // Delta incompleto (archivos demo antiguos): usar HTML si tiene más contenido
      const htmlText = htmlToText(project?.content?.html || '');
      return countWords(htmlText) > countWords(t) * 1.5 ? htmlText : t;
    }
    return htmlToText(project?.content?.html || '');
  }

  /**
   * Procedencia del TEXTO FINAL: caracteres (sin saltos de línea ni espacios) por tipo.
   * Devuelve null si el archivo no tiene delta fiable (formato antiguo).
   */
  function computeProvenance(project) {
    const ops = project?.content?.delta?.ops;
    if (!Array.isArray(ops) || !ops.length) return null;
    const out = { typed: 0, notes: 0, quote: 0, ai: 0, paste: 0, citation: 0 };
    for (const op of ops) {
      if (typeof op.insert === 'string') {
        const n = op.insert.replace(/\s+/g, '').length;
        if (!n) continue;
        out[classifyBackground(op.attributes?.background)] += n;
      } else if (op.insert && op.insert['academic-table']) {
        out.typed += tableTextFromEmbed(op.insert['academic-table']).replace(/\s+/g, '').length;
      }
    }
    // Delta truncado de archivos demo: la procedencia no representaría el documento
    const total0 = out.typed + out.notes + out.quote + out.ai + out.paste + out.citation;
    const htmlChars = htmlToText(project?.content?.html || '').replace(/\s+/g, '').length;
    if (total0 > 0 && htmlChars > total0 * 1.5) return null;
    return provenanceFromCounts(out);
  }

  /** Porcentajes de procedencia a partir de los conteos de caracteres por tipo. */
  function provenanceFromCounts(c) {
    const out = { typed: 0, notes: 0, quote: 0, ai: 0, paste: 0, citation: 0 };
    Object.keys(out).forEach(k => { out[k] = Number(c && c[k]) || 0; });
    const body = out.typed + out.notes + out.quote + out.ai + out.paste; // las referencias son neutras
    const total = body + out.citation;
    if (total === 0) return { ...out, body: 0, total: 0, shares: null };
    const share = k => body > 0 ? out[k] / body : 0;
    return {
      ...out, body, total,
      shares: { typed: share('typed'), notes: share('notes'), quote: share('quote'), ai: share('ai'), paste: share('paste') },
    };
  }

  /* ------------------------------------------------------------------
     MÉTRICAS
     ------------------------------------------------------------------ */
  function computeMetrics(project) {
    project = project || {};
    const sessions = Array.isArray(project.telemetry?.sessions) ? project.telemetry.sessions : [];
    const sources  = Array.isArray(project.sources) ? project.sources : [];
    const captures = project.captures || {};

    // El servidor (Google Sheets) no guarda el texto del trabajo: recibe una "instantánea"
    // con el conteo de palabras y la procedencia calculados en el dispositivo del estudiante.
    const snap = project.snapshot || null;
    const hasContent = !!(project.content && ((project.content.delta?.ops || []).length || project.content.html));
    const wordCount = hasContent ? countWords(documentText(project)) : (Number(snap?.word_count) || 0);
    const provenance = hasContent ? computeProvenance(project)
      : (snap?.provenance ? provenanceFromCounts(snap.provenance) : null);

    // ---- Eventos de pegado por tipo (todas las sesiones, todos los dispositivos) ----
    const pastes = { notes: { n: 0, chars: 0, words: 0 }, quote: { n: 0, chars: 0, words: 0 },
                     ai: { n: 0, chars: 0, words: 0 }, paste: { n: 0, chars: 0, words: 0 } };
    let wordsTyped = 0;
    sessions.forEach(s => {
      wordsTyped += s.words_typed || 0;
      (s.paste_events || []).forEach(p => {
        const k = pasteKind(p);
        pastes[k].n++;
        pastes[k].chars += p.chars_pasted || 0;
        pastes[k].words += p.approx_words || Math.round((p.chars_pasted || 0) / 5);
      });
    });

    // Ratio basado en eventos (solo para archivos antiguos sin procedencia)
    const eventTotal = wordsTyped + pastes.paste.words;
    const eventRatio = eventTotal > 0 ? wordsTyped / eventTotal : 1;

    const typedShare = provenance?.shares ? provenance.shares.typed : eventRatio;
    const undeclaredShare = provenance?.shares ? provenance.shares.paste
      : (eventTotal > 0 ? pastes.paste.words / eventTotal : 0);

    // ---- Sesiones, días y dispositivos ----
    const days = new Set(sessions.map(s => s.date).filter(Boolean));
    const devices = {};
    sessions.forEach(s => {
      const d = s.device;
      if (!d || !d.id) return; // sesiones de versiones anteriores: dispositivo no registrado
      const key = d.id;
      if (!devices[key]) devices[key] = { id: key, label: d.label || 'Dispositivo sin identificar', class: d.class || 'keyboard', sessions: 0 };
      devices[key].sessions++;
    });

    // ---- Proceso de escritura (agregado) ----
    const proc = { chars_typed: 0, chars_deleted: 0, text_keys: 0, nonlinear_edits: 0,
                   pauses_2s: 0, active_ms: 0, sessions_with_process: 0 };
    const procKeyboard = { chars_typed: 0, chars_deleted: 0, nonlinear_edits: 0 };
    sessions.forEach(s => {
      const p = s.process;
      if (!p) return;
      proc.sessions_with_process++;
      ['chars_typed', 'chars_deleted', 'text_keys', 'nonlinear_edits', 'pauses_2s', 'active_ms']
        .forEach(k => { proc[k] += p[k] || 0; });
      if ((s.device?.class || 'keyboard') === 'keyboard') {
        procKeyboard.chars_typed += p.chars_typed || 0;
        procKeyboard.chars_deleted += p.chars_deleted || 0;
        procKeyboard.nonlinear_edits += p.nonlinear_edits || 0;
      }
    });
    proc.revision_ratio = proc.chars_typed > 0 ? proc.chars_deleted / proc.chars_typed : null;
    proc.nonlinear_per_1000 = proc.chars_typed > 0 ? (proc.nonlinear_edits / proc.chars_typed) * 1000 : null;
    proc.keyboard = {
      ...procKeyboard,
      revision_ratio: procKeyboard.chars_typed > 0 ? procKeyboard.chars_deleted / procKeyboard.chars_typed : null,
      nonlinear_per_1000: procKeyboard.chars_typed > 0 ? (procKeyboard.nonlinear_edits / procKeyboard.chars_typed) * 1000 : null,
    };

    // ---- Biometría: SOLO teclado físico y por sesión ----
    const bio = project.biometrics || {};
    const baselineKb = bio.baselines?.keyboard || bio.baseline || snap?.baseline || null;
    const hasBaseline = !!(baselineKb && (baselineKb.sample_size || 0) >= 100);
    const bioSessions = sessions.filter(s =>
      (s.device?.class || 'keyboard') === 'keyboard' &&
      s.biometrics && typeof s.biometrics.similarity_score === 'number' &&
      (s.biometrics.samples || 0) >= POLICY.BIO_MIN_SAMPLES);
    const lastBio = bioSessions.length ? bioSessions[bioSessions.length - 1].biometrics : null;
    const worstBio = bioSessions.length ? Math.min(...bioSessions.map(s => s.biometrics.similarity_score)) : null;
    const bioScore = lastBio ? lastBio.similarity_score
      : (bio.session_metrics?.similarity_score ?? (hasBaseline ? 100 : null));
    const keyboardWords = sessions.filter(s => (s.device?.class || 'keyboard') === 'keyboard')
                                  .reduce((a, s) => a + (s.words_typed || 0), 0);

    // ---- Fuentes y capturas ----
    const captureFiles = Object.keys(captures);
    const sourcesWithShot = sources.filter(s => s.screenshot_filename).length;

    return {
      student_name:  project.metadata?.student_name || '',
      student_email: project.metadata?.student_email || '',
      doc_title:     project.metadata?.title || 'Sin título',
      project_id:    project.metadata?.project_id || '',
      created_at:    project.metadata?.created_at,
      last_saved:    project.metadata?.last_saved,

      word_count: wordCount,
      provenance,                                   // null en archivos antiguos
      typed_share: typedShare,                      // salud principal: % del texto final tecleado
      manual_ratio: typedShare,                     // alias de compatibilidad
      undeclared_share: undeclaredShare,
      measured_on_final_text: !!provenance?.shares,

      total_sessions: sessions.length,
      total_days_active: days.size,
      devices: Object.values(devices),
      total_words_typed: wordsTyped,
      pastes,
      total_chars_pasted: pastes.paste.chars,       // solo sin declarar
      initial_paste_words: pastes.notes.words,      // compatibilidad (material base)

      process: proc,

      has_biometric_baseline: hasBaseline,
      biometric_score: bioScore,
      biometric_worst: worstBio,
      biometric_dwell: lastBio?.mean_dwell_ms || baselineKb?.mean_dwell_ms || null,
      biometric_flight: lastBio?.mean_flight_ms || baselineKb?.mean_flight_ms || null,
      keyboard_words_typed: keyboardWords,

      sources_count: (!sources.length && snap) ? (Number(snap.sources_count) || 0) : sources.length,
      sources_with_screenshot: (!sources.length && snap) ? (Number(snap.sources_with_screenshot) || 0) : sourcesWithShot,
      sources_cited_in_text: (!sources.length && snap) ? (Number(snap.sources_cited_in_text) || 0) : sources.filter(s => s.cited_in_text).length,
      captures_registered: (!captureFiles.length && snap) ? (Number(snap.captures_registered) || 0) : captureFiles.length,
      captures_verified: null,                      // el dashboard lo completa si recibe el paquete .zip
      sessions,
    };
  }

  /* ------------------------------------------------------------------
     ALERTAS (mismas reglas para estudiante y docente)
     ------------------------------------------------------------------ */
  function pct(x) { return Math.round((x || 0) * 100) + '%'; }

  function computeAlerts(m, opts = {}) {
    const P = POLICY;
    const alerts = [];
    const add = (level, message, code) => alerts.push({ level, message, code });

    // Volumen de texto que no es material declarado
    const declaredWords = m.pastes.notes.words + m.pastes.quote.words + m.pastes.ai.words;
    const netOwn = Math.max(0, m.word_count - declaredWords);

    // 1. Proceso incremental
    if (m.total_sessions <= 1 && netOwn > 200) {
      add('danger', 'Documento realizado en 1 sola sesión (sin proceso incremental)', 'one_session');
    } else if (m.total_sessions <= 2 && netOwn > 600) {
      add('warning', `Solo ${m.total_sessions} sesiones para un manuscrito de ${netOwn} palabras propias`, 'few_sessions');
    }
    (m.sessions || []).forEach(s => {
      const net = (s.words_net_change !== undefined) ? s.words_net_change : ((s.final_word_count || 0) - (s.initial_word_count || 0));
      const min = Math.max(1, s.duration_minutes || 1);
      const declared = (s.paste_events || []).filter(p => pasteKind(p) !== 'paste')
        .reduce((a, p) => a + (p.approx_words || Math.round((p.chars_pasted || 0) / 5)), 0);
      const eff = Math.max(0, net - declared);
      if (eff > P.BURST_WORDS && eff / min > P.BURST_WPM) {
        add('warning', `Salto atípico en sesión ${s.session_number || ''} (${s.date || ''}): +${eff} palabras en ${min} min`, 'burst');
      }
    });
    if (m.word_count > 1000 && m.total_days_active <= 1) {
      add('warning', `${m.word_count} palabras en solo ${m.total_days_active} día(s)`, 'few_days');
    }

    // 2. Procedencia del texto final. Lo declarado no se castiga aquí (tiene su propio
    //    presupuesto más abajo); solo se avisa si muy poco del texto fue tecleado.
    if (m.word_count >= 150 && m.typed_share < P.TYPED_DANGER) {
      add('warning', `Solo ${pct(m.typed_share)} del texto fue tecleado en el editor`, 'typed_low');
    }
    if (m.undeclared_share >= P.UNDECLARED_DANGER) {
      add('danger', `${pct(m.undeclared_share)} del texto proviene de pegados sin declarar`, 'undeclared_high');
    } else if (m.undeclared_share >= P.UNDECLARED_WARN) {
      add('warning', `${pct(m.undeclared_share)} del texto proviene de pegados sin declarar`, 'undeclared_mid');
    }
    const sh = m.provenance?.shares;
    if (sh) {
      if (sh.notes > P.NOTES_MAX_SHARE) add('warning', `Notas propias declaradas: ${pct(sh.notes)} (límite ${pct(P.NOTES_MAX_SHARE)})`, 'notes_budget');
      if (sh.quote > P.QUOTES_MAX_SHARE) add('warning', `Citas textuales: ${pct(sh.quote)} (límite ${pct(P.QUOTES_MAX_SHARE)})`, 'quotes_budget');
      if (sh.ai > P.AI_MAX_SHARE) add('danger', `Texto con IA declarado: ${pct(sh.ai)} (límite ${pct(P.AI_MAX_SHARE)})`, 'ai_budget');
      else if (sh.ai > 0) add('info', `Contiene ${pct(sh.ai)} de texto con IA declarado`, 'ai_present');
    }

    // 3. Patrón de transcripción (teclear un texto ajeno de corrido) — solo teclado físico
    const kb = m.process.keyboard;
    if (kb.chars_typed >= P.TRANSCRIPTION_MIN_CHARS && kb.revision_ratio !== null &&
        kb.revision_ratio < P.TRANSCRIPTION_REVISION_MAX &&
        (kb.nonlinear_per_1000 ?? 0) < P.TRANSCRIPTION_NONLINEAR_MAX) {
      add('warning', `Patrón de transcripción: casi sin correcciones (${pct(kb.revision_ratio)}) ni regresos a texto anterior en ${kb.chars_typed.toLocaleString('es')} caracteres tecleados`, 'transcription');
    }

    // 4. Biometría (informativa, solo teclado físico)
    if (m.has_biometric_baseline && m.biometric_worst !== null && m.biometric_worst < P.BIO_WARN) {
      add('warning', `Biometría: una sesión con teclado tuvo ${m.biometric_worst}% de consistencia con la huella (indicio, no prueba)`, 'bio_low');
    } else if (m.has_biometric_baseline && m.biometric_worst !== null && m.biometric_worst < P.BIO_OK) {
      add('info', `Biometría: variación moderada del ritmo de tecleo (mín. ${m.biometric_worst}%)`, 'bio_mid');
    } else if (!m.has_biometric_baseline && m.keyboard_words_typed > 300) {
      add('info', 'Huella de tecleo aún sin calibrar con teclado físico', 'bio_none');
    }

    // 5. Fuentes y evidencia
    if (m.sources_count === 0) {
      add('danger', 'No hay fuentes registradas', 'no_sources');
    } else if (m.sources_with_screenshot === 0) {
      add('danger', 'Ninguna fuente tiene captura de evidencia', 'no_captures');
    } else if (m.sources_with_screenshot < m.sources_count / 2) {
      add('warning', 'Menos de la mitad de las fuentes tiene captura', 'few_captures');
    }
    if (m.captures_verified && m.captures_verified.missing > 0) {
      add('warning', `${m.captures_verified.missing} captura(s) referenciada(s) no vienen en el paquete`, 'captures_missing');
    }
    if (m.captures_verified && m.captures_verified.mismatch > 0) {
      add('danger', `${m.captures_verified.mismatch} captura(s) no coinciden con su huella SHA-256 registrada`, 'captures_mismatch');
    }

    // 6. Integridad (solo el docente la conoce al cargar el archivo)
    if (opts.integrity_ok === false) {
      add('warning', 'Posible modificación manual del archivo JSON', 'integrity');
    }
    return alerts;
  }

  function alertLevel(alerts) {
    if ((alerts || []).some(a => a.level === 'danger'))  return 'danger';
    if ((alerts || []).some(a => a.level === 'warning')) return 'warning';
    return 'ok';
  }

  function bioLevel(score) {
    if (score === null || score === undefined) return 'none';
    if (score >= POLICY.BIO_OK) return 'ok';
    if (score >= POLICY.BIO_WARN) return 'warning';
    return 'danger';
  }

  /* ------------------------------------------------------------------
     SINCRONIZACIÓN CON GOOGLE SHEETS
     ------------------------------------------------------------------ */

  /** Instantánea del estado del documento (lo que el servidor necesita y no puede calcular). */
  function makeSnapshot(m) {
    const p = m.provenance || {};
    const bl = m._baseline || null;
    return {
      word_count: m.word_count,
      provenance: { typed: p.typed || 0, notes: p.notes || 0, quote: p.quote || 0, ai: p.ai || 0, paste: p.paste || 0, citation: p.citation || 0 },
      sources_count: m.sources_count,
      sources_with_screenshot: m.sources_with_screenshot,
      sources_cited_in_text: m.sources_cited_in_text,
      captures_registered: m.captures_registered,
      baseline: bl,
    };
  }

  /** Versión compacta de una sesión para guardarla en UNA celda de Sheets (< 45 000 caracteres). */
  function compactSession(rec, maxChars = 45000) {
    const s = JSON.parse(JSON.stringify(rec || {}));
    const tl = Array.isArray(s.timeline) ? s.timeline : [];
    if (tl.length > 150) {
      const step = tl.length / 150;
      s.timeline = Array.from({ length: 150 }, (_, i) => tl[Math.floor(i * step)]).concat([tl[tl.length - 1]]);
    }
    (s.paste_events || []).forEach(p => { if (p.excerpt && p.excerpt.length > 160) p.excerpt = p.excerpt.slice(0, 160); });
    let json = JSON.stringify(s);
    if (json.length > maxChars) { s.timeline = (s.timeline || []).filter((_, i) => i % 3 === 0); json = JSON.stringify(s); }
    if (json.length > maxChars) { (s.paste_events || []).forEach(p => { p.excerpt = (p.excerpt || '').slice(0, 40); }); json = JSON.stringify(s); }
    if (json.length > maxChars) { s.paste_events = (s.paste_events || []).slice(-150); s.truncated = true; }
    return s;
  }

  /** Métricas sin la lista de sesiones (para enviarlas por la red o guardarlas en una celda). */
  function slimMetrics(m) {
    const o = { ...m };
    delete o.sessions;
    return o;
  }

  global.EOTS = {
    POLICY, PROVENANCE, PASTE_KINDS,
    classifyBackground, isProvenanceBackground, pasteKind,
    countWords, htmlToText, documentText, computeProvenance,
    computeMetrics, computeAlerts, alertLevel, bioLevel, pct,
    provenanceFromCounts, makeSnapshot, compactSession, slimMetrics,
  };
})(typeof window !== 'undefined' ? window : globalThis);
