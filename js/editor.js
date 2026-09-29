/**
 * Eye on the Sky — editor.js
 * Lógica completa del editor para el estudiante:
 *   - Gestión de carpeta del proyecto (File System Access API)
 *   - Autoguardado cada 30 segundos
 *   - Telemetría: keystrokes, eventos de pegado, sesiones
 *   - Gestión de fuentes bibliográficas
 *   - Inserción de capturas PDF (imágenes locales)
 *   - Generación de citas Chicago / APA
 *   - Exportación: PDF (print), DOCX, RIS para Zotero
 *   - Firma SHA-256 del JSON para detectar manipulación
 */

'use strict';

/* ================================================================
   ESTADO GLOBAL DE LA APLICACIÓN
   ================================================================ */

const App = {
  // Handles del sistema de archivos
  dirHandle:      null,   // FileSystemDirectoryHandle del proyecto
  capturasHandle: null,   // FileSystemDirectoryHandle de subcarpeta capturas/
  jsonFileHandle: null,   // FileSystemFileHandle del documento.json

  // Datos del proyecto (lo que se serializa a JSON)
  project: {
    metadata: {
      title:         '',
      course:        'Seminario de Grado',
      student_name:  '',
      created_at:    new Date().toISOString(),
      last_saved:    null,
      app_version:   '1.0.0',
      schema_version: 1,
    },
    content: {
      delta: null,   // Quill Delta (fuente de verdad)
      html:  '',
    },
    sources:   [],  // Array de objetos fuente bibliográfica
    telemetry: {
      sessions: [],
      summary: {
        total_sessions:       0,
        total_days_active:    0,
        total_words_typed:    0,
        total_chars_pasted:   0,
        manual_ratio:         0,
        sources_with_screenshot: 0,
        sources_cited_in_text:   0,
      }
    }
  },

  // Estado de la sesión actual
  session: {
    id:                null,   // 'ses_...'
    session_number:    1,
    start_time:        null,
    words_typed:       0,
    chars_pasted:      0,
    paste_events:      [],
    keystroke_count:   0,
    initial_word_count: 0,
    active_days_set:   new Set(),
    timer_ref:         null,
    autosave_ref:      null,
    previousWordCount: 0,  // para calcular diff de palabras real
    isPasting:         false, // flag para text-change: ignorar palabras de paste
  },

  // Flags de UI
  ui: {
    sourcesPanelOpen: true,
    telePanelOpen:    true,
    isDirty:          false,  // hay cambios sin guardar
    currentTheme:     'light',
    projectLoaded:    false,
    editingSourceId:  null,   // null = nueva fuente, string = editar existente
    pendingScreenshot: null,  // { file, previewUrl }
  },

  // Instancia de Quill
  quill: null,
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initQuill();
  initEventListeners();
  initSessionTimer();
  restoreTheme();
});

function initQuill() {
  App.quill = new Quill('#quill-editor', {
    theme: 'snow',
    modules: {
      toolbar: '#quill-toolbar',
    },
    placeholder: 'Comienza a escribir tu documento de investigación aquí…',
  });

  // Telemetría: detectar texto tecleado vs pegado
  App.quill.on('text-change', (delta, oldDelta, source) => {
    if (source !== 'user') return;
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');

    const text       = App.quill.getText();
    const currentWC  = countWords(text);
    const wordDiff   = Math.max(0, currentWC - App.session.previousWordCount);

    // Solo sumar al conteo manual si NO fue un pegado
    if (!App.session.isPasting && wordDiff > 0) {
      App.session.words_typed += wordDiff;
    }

    App.session.previousWordCount = currentWC;
    updateWordCount(currentWC);
    updateTelemetryUI();
  });

  // Activar corrector ortográfico nativo del navegador en español
  const editorEl = document.querySelector('#quill-editor .ql-editor');
  if (editorEl) {
    editorEl.setAttribute('spellcheck', 'true');
    editorEl.setAttribute('lang', 'es');
    editorEl.setAttribute('autocorrect', 'on');
    editorEl.addEventListener('paste', handlePasteEvent);
    editorEl.addEventListener('keydown', handleKeystrokeEvent);
  }
}

/* ================================================================
   TELEMETRÍA
   ================================================================ */

function handlePasteEvent(e) {
  const clipText = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  const chars = clipText.length;
  if (chars < 10) return; // ignora pegados triviales

  // ¿El documento estaba vacío antes del pegado?
  const isInitialPaste = App.session.previousWordCount === 0;

  // Activar flag para que text-change no cuente estas palabras como manuales
  App.session.isPasting = true;
  setTimeout(() => { App.session.isPasting = false; }, 300);

  const pasteRecord = {
    timestamp:    new Date().toISOString(),
    chars_pasted: chars,
    approx_words: Math.round(chars / 5),
    is_initial:   isInitialPaste,
  };

  App.session.paste_events.push(pasteRecord);

  if (!isInitialPaste) {
    // Solo penalizar pastes que no son el inicial
    App.session.chars_pasted += chars;
  } else {
    showToast('Pegado inicial registrado sin penalización.', 'success');
  }

  updateTelemetryUI();
}

function handleKeystrokeEvent(e) {
  // Solo registrar para telemetría (el conteo de palabras ya lo hace text-change)
  const ignore = ['Control','Alt','Shift','Meta','CapsLock','Tab','Escape',
    'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown',
    'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
  if (ignore.includes(e.key)) return;
  App.session.keystroke_count++;
}

function initSessionTimer() {
  App.session.start_time = new Date();
  App.session.timer_ref = setInterval(() => {
    if (!App.session.start_time) return;
    const elapsed = Math.floor((Date.now() - App.session.start_time.getTime()) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    const teleTimerEl = document.getElementById('tele-session-time');
    const sbTimerEl   = document.getElementById('sb-session-time');
    if (teleTimerEl) teleTimerEl.textContent = `${mm}:${ss}`;
    if (sbTimerEl)   sbTimerEl.textContent   = `Sesión: ${mm}:${ss}`;
  }, 1000);
}

function updateTelemetryUI() {
  const typed = App.session.words_typed;

  // Solo contar pastes NO iniciales para el ratio de la sesión actual
  const penalizedPasteWords = App.session.paste_events
    .filter(ev => !ev.is_initial)
    .reduce((sum, ev) => sum + (ev.approx_words || 0), 0);

  const total = typed + penalizedPasteWords;
  // Si no hay actividad aún, ratio = 100% (no mostrar 0)
  const ratio = total > 0 ? Math.round((typed / total) * 100) : 100;

  const wordsTypedEl = document.getElementById('tele-words-typed');
  if (wordsTypedEl) wordsTypedEl.textContent = typed;
  const pasteCountEl = document.getElementById('tele-paste-count');
  if (pasteCountEl) pasteCountEl.textContent = App.session.paste_events.filter(ev => !ev.is_initial).length;

  // Barra de salud
  const fill = document.getElementById('health-fill');
  const pct  = document.getElementById('health-percent');
  if (fill && pct) {
    fill.style.width = `${ratio}%`;
    pct.textContent  = `${ratio}%`;
    fill.classList.remove('medium', 'low');
    if (ratio < 50) fill.classList.add('low');
    else if (ratio < 75) fill.classList.add('medium');
  }

  // Fuentes con captura
  const withImg    = (App.project.sources || []).filter(s => s.screenshot_filename).length;
  const totalSrcs  = (App.project.sources || []).length;
  const sourcesImgEl = document.getElementById('tele-sources-with-img');
  if (sourcesImgEl) sourcesImgEl.textContent = `${withImg}/${totalSrcs}`;

  // Totales acumulados históricos
  const totalSessionsCount = (App.project.telemetry?.sessions || []).length || 1;
  const totalSessionsEl = document.getElementById('tele-total-sessions');
  if (totalSessionsEl) totalSessionsEl.textContent = totalSessionsCount;

  const daysActiveEl = document.getElementById('tele-days-active');
  if (daysActiveEl) {
    const daysSet = new Set((App.project.telemetry?.sessions || []).map(s => s.date).filter(Boolean));
    if (App.session.start_time) {
      daysSet.add(App.session.start_time.toISOString().split('T')[0]);
    }
    daysActiveEl.textContent = daysSet.size || 1;
  }
}

/* ================================================================
   GESTIÓN DEL PROYECTO (File System Access API)
   ================================================================ */

async function openOrCreateProject(mode) {
  if (!('showDirectoryPicker' in window)) {
    showToast('Tu navegador no soporta la API de acceso a archivos. Usa Chrome o Edge.', 'error');
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    App.dirHandle = dirHandle;

    // Crear o abrir subcarpeta capturas/
    App.capturasHandle = await dirHandle.getDirectoryHandle('capturas', { create: true });

    if (mode === 'new') {
      await createNewProject(dirHandle);
    } else {
      await loadExistingProject(dirHandle);
    }

    // Cerrar modal de onboarding
    closeModal('modal-onboarding-overlay');
    App.ui.projectLoaded = true;

    // Actualizar nombre del proyecto en statusbar
    document.getElementById('sb-project-name').textContent = dirHandle.name;
    document.getElementById('open-folder-label').textContent = 'Cambiar carpeta';

    // Iniciar autoguardado (cada 30 segundos)
    startAutosave();

  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('Error al abrir carpeta:', err);
      showToast('No se pudo abrir la carpeta. ' + err.message, 'error');
    }
  }
}

function startProjectSession() {
  const currentText = App.quill ? App.quill.getText() : '';
  const currentWC = countWords(currentText);

  // Asegurar estructura de telemetría en el proyecto
  if (!App.project.telemetry) {
    App.project.telemetry = { sessions: [], summary: {} };
  }
  if (!Array.isArray(App.project.telemetry.sessions)) {
    App.project.telemetry.sessions = [];
  }

  const sessionNum = App.project.telemetry.sessions.length + 1;
  const now = new Date();

  App.session.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  App.session.session_number = sessionNum;
  App.session.start_time = now;
  App.session.words_typed = 0;
  App.session.chars_pasted = 0;
  App.session.paste_events = [];
  App.session.keystroke_count = 0;
  App.session.initial_word_count = currentWC;
  App.session.previousWordCount = currentWC;

  // Reconstruir conjunto de fechas activas
  App.session.active_days_set = new Set(
    App.project.telemetry.sessions.map(s => s.date).filter(Boolean)
  );
  App.session.active_days_set.add(now.toISOString().split('T')[0]);

  updateTelemetryUI();
}

async function createNewProject(dirHandle) {
  // Inicializar metadatos del proyecto
  App.project.metadata.created_at = new Date().toISOString();
  App.project.metadata.title = 'Sin título';
  document.getElementById('doc-title-input').value = '';

  startProjectSession();
  await saveProject();
  showToast('Proyecto creado. El autoguardado está activo.', 'success');
}

async function loadExistingProject(dirHandle) {
  try {
    const jsonHandle = await dirHandle.getFileHandle('documento.json');
    const file   = await jsonHandle.getFile();
    const text   = await file.text();
    const parsed = JSON.parse(text);

    // Verificar firma de integridad
    const storedSig = parsed._signature;
    if (storedSig) {
      const valid = await verifySignature(parsed);
      if (!valid) {
        showToast('⚠ El archivo JSON fue modificado externamente. Los datos pueden no ser confiables.', 'warning');
      }
    }

    // Cargar datos
    App.project = { ...App.project, ...parsed };
    delete App.project._signature;

    // Restaurar contenido en Quill
    if (App.project.content && App.project.content.delta) {
      App.quill.setContents(App.project.content.delta, 'silent');
    } else if (App.project.content && App.project.content.html) {
      App.quill.clipboard.dangerouslyPasteHTML(App.project.content.html);
    }

    // Restaurar título
    document.getElementById('doc-title-input').value = App.project.metadata.title || '';

    // Cargar fuentes en el panel
    renderSourcesList();

    // Contar palabras
    const currentWC = countWords(App.quill.getText());
    updateWordCount(currentWC);

    // Inicializar nueva sesión de trabajo con el punto de partida actual
    startProjectSession();

    // Guardar para registrar la apertura de la nueva sesión
    await saveProject();

    showToast(`Proyecto "${App.project.metadata.title || 'Sin título'}" cargado.`, 'success');
    updateSaveStatus('saved');

  } catch (err) {
    if (err.name === 'NotFoundError') {
      // No existe documento.json → es una carpeta nueva
      await createNewProject(dirHandle);
    } else {
      throw err;
    }
  }
}

/* ================================================================
   AUTOGUARDADO
   ================================================================ */

function startAutosave() {
  if (App.session.autosave_ref) clearInterval(App.session.autosave_ref);
  App.session.autosave_ref = setInterval(async () => {
    if (!App.ui.isDirty || !App.dirHandle) return;
    await saveProject();
  }, 30_000); // cada 30 segundos
}

async function saveProject() {
  if (!App.dirHandle) return;

  updateSaveStatus('saving');

  try {
    // Capturar estado actual del editor
    App.project.content.delta = App.quill.getContents();
    App.project.content.html  = App.quill.root.innerHTML;
    App.project.metadata.title = document.getElementById('doc-title-input').value.trim() || 'Sin título';
    App.project.metadata.last_saved = new Date().toISOString();

    const currentWC = countWords(App.quill.getText());
    const now = new Date();
    const startTime = App.session.start_time || now;
    const durationMin = Math.max(1, Math.round((now.getTime() - startTime.getTime()) / 60000));
    const todayISO = startTime.toISOString().split('T')[0];

    // Asegurar estructura
    if (!App.project.telemetry) App.project.telemetry = { sessions: [], summary: {} };
    if (!Array.isArray(App.project.telemetry.sessions)) App.project.telemetry.sessions = [];

    // Si aún no hay ID de sesión, generar uno
    if (!App.session.id) {
      App.session.id = 'ses_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      App.session.session_number = App.project.telemetry.sessions.length + 1;
    }

    // Registro detallado de la sesión activa
    const currentSessionRecord = {
      session_id:         App.session.id,
      session_number:     App.session.session_number,
      date:               todayISO,
      start_time:         startTime.toISOString(),
      end_time:           now.toISOString(),
      duration_minutes:   durationMin,
      initial_word_count: App.session.initial_word_count || 0,
      final_word_count:   currentWC,
      words_net_change:   currentWC - (App.session.initial_word_count || 0),
      words_typed:        App.session.words_typed,
      chars_pasted:       App.session.chars_pasted,
      paste_events:       [...App.session.paste_events],
      keystroke_count:    App.session.keystroke_count,
    };

    // Actualizar o agregar la sesión activa en el historial de sesiones
    const existingIndex = App.project.telemetry.sessions.findIndex(s => s.session_id === App.session.id);
    if (existingIndex >= 0) {
      App.project.telemetry.sessions[existingIndex] = currentSessionRecord;
    } else {
      App.project.telemetry.sessions.push(currentSessionRecord);
    }

    // Consolidar resumen de todas las sesiones
    const allSessions = App.project.telemetry.sessions;
    const daysSet = new Set(allSessions.map(s => s.date).filter(Boolean));
    const totalWordsTyped = allSessions.reduce((sum, s) => sum + (s.words_typed || 0), 0);
    const totalCharsPasted = allSessions.reduce((sum, s) => sum + (s.chars_pasted || 0), 0);

    let allPenalizedPasteWords = 0;
    allSessions.forEach(s => {
      (s.paste_events || []).forEach(ev => {
        if (!ev.is_initial) allPenalizedPasteWords += (ev.approx_words || 0);
      });
    });

    const totalCalculated = totalWordsTyped + allPenalizedPasteWords;
    const manualRatio = totalCalculated > 0 ? (totalWordsTyped / totalCalculated) : 1;

    App.project.telemetry.summary = {
      total_sessions:          allSessions.length,
      total_days_active:       daysSet.size,
      total_words_typed:       totalWordsTyped,
      total_chars_pasted:      totalCharsPasted,
      manual_ratio:            Math.round(manualRatio * 100) / 100,
      sources_with_screenshot: (App.project.sources || []).filter(s => s.screenshot_filename).length,
      sources_cited_in_text:   (App.project.sources || []).filter(s => s.cited_in_text).length,
    };

    // Crear objeto a serializar (sin imágenes base64 — solo rutas relativas)
    const payload = structuredClone(App.project);

    // Agregar firma de integridad
    payload._signature = await signPayload(payload);

    const json = JSON.stringify(payload, null, 2);

    // Escribir al archivo
    const fileHandle = await App.dirHandle.getFileHandle('documento.json', { create: true });
    const writable   = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();

    App.ui.isDirty = false;
    updateSaveStatus('saved', App.project.metadata.last_saved);

  } catch (err) {
    console.error('Error al guardar:', err);
    updateSaveStatus('error');
    showToast('Error al guardar automáticamente: ' + err.message, 'error');
  }
}

/* ================================================================
   FIRMA CRIPTOGRÁFICA (SHA-256) PARA DETECTAR MANIPULACIÓN
   ================================================================ */

async function signPayload(payload) {
  const clone = structuredClone(payload);
  delete clone._signature;
  // Usamos una clave estática derivada de la versión de la app
  // (no es criptografía fuerte, pero detecta edición manual del JSON)
  const secret = 'EyeOnTheSky-v1-integrity';
  const data   = secret + JSON.stringify(clone);
  const msgBuf = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest('SHA-256', msgBuf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function verifySignature(payload) {
  const stored = payload._signature;
  const expected = await signPayload(payload);
  return stored === expected;
}

/* ================================================================
   GESTIÓN DE FUENTES BIBLIOGRÁFICAS
   ================================================================ */

function openAddSourceModal(editId = null) {
  App.ui.editingSourceId = editId;
  clearSourceForm();

  if (editId) {
    const src = App.project.sources.find(s => s.id === editId);
    if (src) populateSourceForm(src);
    document.getElementById('modal-source-title').textContent = 'Editar fuente';
  } else {
    document.getElementById('modal-source-title').textContent = 'Agregar fuente bibliográfica';
  }

  openModal('modal-source-overlay');
}

function clearSourceForm() {
  ['source-doi-search','source-title','source-authors','source-year',
   'source-doi','source-journal','source-pages'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('source-type').value = 'journal';
  document.getElementById('source-citation-style').value = 'chicago-note';
  document.getElementById('screenshot-preview').classList.add('hidden');
  document.getElementById('source-screenshot-dropzone').classList.remove('hidden');
  document.getElementById('screenshot-preview-img').src = '';
  App.ui.pendingScreenshot = null;
}

function populateSourceForm(src) {
  document.getElementById('source-type').value = src.type || 'journal';
  document.getElementById('source-title').value = src.title || '';
  document.getElementById('source-authors').value = (src.authors || []).join('; ');
  document.getElementById('source-year').value = src.year || '';
  document.getElementById('source-doi').value = src.doi || '';
  document.getElementById('source-journal').value = src.journal || '';
  document.getElementById('source-pages').value = src.pages || '';
  document.getElementById('source-citation-style').value = src.citation_style || 'chicago-note';
}

async function saveSource() {
  const title   = document.getElementById('source-title').value.trim();
  const authors = document.getElementById('source-authors').value.trim();
  const year    = document.getElementById('source-year').value.trim();

  if (!title || !authors || !year) {
    showToast('Completa los campos obligatorios: Título, Autor(es) y Año.', 'warning');
    return;
  }

  const source = {
    id:             App.ui.editingSourceId || generateId(),
    type:           document.getElementById('source-type').value,
    title,
    authors:        authors.split(';').map(a => a.trim()).filter(Boolean),
    year:           parseInt(year),
    doi:            document.getElementById('source-doi').value.trim(),
    journal:        document.getElementById('source-journal').value.trim(),
    pages:          document.getElementById('source-pages').value.trim(),
    citation_style: document.getElementById('source-citation-style').value,
    screenshot_filename: null,
    cited_in_text:  false,
    added_at:       new Date().toISOString(),
  };

  // Si hay captura pendiente, copiarla a la carpeta capturas/
  if (App.ui.pendingScreenshot && App.capturasHandle) {
    const ext      = App.ui.pendingScreenshot.file.name.split('.').pop();
    const filename = `captura_${source.id}.${ext}`;
    try {
      const fh  = await App.capturasHandle.getFileHandle(filename, { create: true });
      const wr  = await fh.createWritable();
      await wr.write(App.ui.pendingScreenshot.file);
      await wr.close();
      source.screenshot_filename = filename;
    } catch (err) {
      showToast('No se pudo guardar la captura: ' + err.message, 'error');
    }
  } else if (App.ui.editingSourceId) {
    // Conservar captura existente si no se cambió
    const existing = App.project.sources.find(s => s.id === App.ui.editingSourceId);
    if (existing) source.screenshot_filename = existing.screenshot_filename;
  }

  // Agregar o reemplazar
  if (App.ui.editingSourceId) {
    const idx = App.project.sources.findIndex(s => s.id === App.ui.editingSourceId);
    if (idx >= 0) App.project.sources[idx] = source;
  } else {
    App.project.sources.push(source);
  }

  closeModal('modal-source-overlay');
  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');
  showToast('Fuente guardada correctamente.', 'success');
}

function deleteSource(id) {
  if (!confirm('¿Eliminar esta fuente? Esta acción no se puede deshacer.')) return;
  App.project.sources = App.project.sources.filter(s => s.id !== id);
  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  showToast('Fuente eliminada.', 'success');
}

function renderSourcesList() {
  const container = document.getElementById('sources-list');
  if (App.project.sources.length === 0) {
    container.innerHTML = `<p class="text-sm text-muted" style="padding: 8px 4px;">
      Aún no hay fuentes registradas. Haz clic en <strong>+</strong> para agregar la primera.
    </p>`;
    return;
  }

  container.innerHTML = '';
  App.project.sources.forEach(src => {
    const authorShort = src.authors && src.authors.length > 0
      ? (src.authors[0].split(',')[0] + (src.authors.length > 1 ? ' et al.' : ''))
      : 'Autor desconocido';

    const card = document.createElement('div');
    card.className = 'source-card fade-in';
    card.dataset.id = src.id;
    card.innerHTML = `
      <div class="source-card-title">${escapeHtml(src.title)}</div>
      <div class="source-card-meta">
        <span>${escapeHtml(authorShort)}</span>
        <span>${src.year || '—'}</span>
        ${src.doi ? `<span title="${escapeHtml(src.doi)}">DOI ✓</span>` : ''}
      </div>
      <div style="margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap;">
        <span class="source-card-badge">${typeLabel(src.type)}</span>
        ${src.screenshot_filename
          ? `<span class="source-card-badge has-screenshot">📸 Captura</span>`
          : `<span class="source-card-badge" style="background:var(--warning-light);color:var(--warning);">Sin captura</span>`}
        ${src.cited_in_text ? `<span class="source-card-badge">Citado en texto</span>` : ''}
      </div>
      <div class="source-card-actions">
        <button class="btn btn-sm btn-ghost" onclick="openAddSourceModal('${src.id}')">Editar</button>
        <button class="btn btn-sm btn-ghost" onclick="insertCitationFromSource('${src.id}')">Citar</button>
        <button class="btn btn-sm btn-ghost text-danger" onclick="deleteSource('${src.id}')">Eliminar</button>
        ${src.screenshot_filename ? `<button class="btn btn-sm btn-ghost" onclick="viewScreenshot('${src.id}')">Ver captura</button>` : ''}
      </div>
    `;
    container.appendChild(card);
  });
}

async function viewScreenshot(sourceId) {
  const src = App.project.sources.find(s => s.id === sourceId);
  if (!src || !src.screenshot_filename || !App.capturasHandle) return;

  try {
    const fh   = await App.capturasHandle.getFileHandle(src.screenshot_filename);
    const file = await fh.getFile();
    const url  = URL.createObjectURL(file);
    window.open(url, '_blank');
  } catch (err) {
    showToast('No se encontró la captura en la carpeta del proyecto.', 'error');
  }
}

/* ================================================================
   INSERCIÓN DE CITAS EN EL TEXTO
   ================================================================ */

function populateCitationSelect() {
  const select = document.getElementById('citation-source-select');
  select.innerHTML = '<option value="">— Elige una fuente registrada —</option>';
  App.project.sources.forEach(src => {
    const opt = document.createElement('option');
    opt.value = src.id;
    const author = src.authors && src.authors.length > 0 ? src.authors[0].split(',')[0] : 'Anón.';
    opt.textContent = `${author} (${src.year}) — ${src.title.substring(0, 50)}${src.title.length > 50 ? '…' : ''}`;
    select.appendChild(opt);
  });
}

function formatCitation(src, pages, style) {
  const authors = src.authors || [];
  const year    = src.year || 'S.f.';
  const title   = src.title || '';
  const journal = src.journal || '';
  const pg      = pages ? (`, ${pages}`) : '';

  if (style === 'chicago-note' || style === 'chicago-author-date') {
    // Chicago nota completa
    const authorStr = authors.length > 0
      ? authors.map((a,i) => i === 0 ? a : reverseAuthorName(a)).join(', ')
      : 'Autor desconocido';
    if (src.type === 'journal') {
      return `${authorStr}, "${title}," <em>${journal}</em> (${year})${pg}.`;
    }
    return `${authorStr}, <em>${title}</em> (${year})${pg}.`;
  }

  if (style === 'apa') {
    const authorStr = authors.map(a => {
      const parts = a.split(',');
      return parts.length > 1 ? `${parts[0].trim()}, ${parts[1].trim().charAt(0)}.` : a;
    }).join(', ');
    return `(${authorStr}, ${year}${pg})`;
  }

  if (style === 'mla') {
    return `(${authors[0] ? authors[0].split(',')[0] : 'Anón.'} ${pg.replace(', ','')})`;
  }

  return `(${authors[0] ? authors[0].split(',')[0] : 'Anón.'}, ${year}${pg})`;
}

function reverseAuthorName(name) {
  const parts = name.split(',');
  return parts.length > 1 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
}

function openCitationModal(sourceId = null) {
  populateCitationSelect();
  if (sourceId) document.getElementById('citation-source-select').value = sourceId;
  document.getElementById('citation-page').value = '';
  updateCitationPreview();
  openModal('modal-citation-overlay');
}

function insertCitationFromSource(sourceId) {
  openCitationModal(sourceId);
}

function updateCitationPreview() {
  const srcId = document.getElementById('citation-source-select').value;
  const pages = document.getElementById('citation-page').value.trim();
  const preview = document.getElementById('citation-preview');

  if (!srcId) {
    preview.innerHTML = 'Selecciona una fuente para ver la cita generada.';
    return;
  }

  const src   = App.project.sources.find(s => s.id === srcId);
  if (!src) return;

  const style = src.citation_style || 'chicago-note';
  preview.innerHTML = formatCitation(src, pages, style);
}

function insertCitationIntoEditor() {
  const srcId = document.getElementById('citation-source-select').value;
  const pages = document.getElementById('citation-page').value.trim();

  if (!srcId) {
    showToast('Selecciona una fuente antes de insertar.', 'warning');
    return;
  }

  const src   = App.project.sources.find(s => s.id === srcId);
  if (!src) return;

  const style    = src.citation_style || 'chicago-note';
  const citation = formatCitation(src, pages, style);

  // Insertar en la posición actual del cursor
  const range = App.quill.getSelection(true);
  App.quill.insertText(range.index, citation, 'user');
  App.quill.setSelection(range.index + citation.length);

  // Marcar fuente como citada
  src.cited_in_text = true;

  closeModal('modal-citation-overlay');
  updateTelemetryUI();
  App.ui.isDirty = true;
  showToast('Cita insertada.', 'success');
}

/* ================================================================
   INSERCIÓN DE CAPTURAS PDF EN EL EDITOR
   ================================================================ */

async function insertScreenshotAtCursor() {
  if (!App.capturasHandle) {
    showToast('Primero debes abrir o crear un proyecto (carpeta).', 'warning');
    return;
  }

  // Crear un input temporal para seleccionar imagen
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    await embedScreenshotInEditor(file);
  };
  input.click();
}

async function embedScreenshotInEditor(file) {
  try {
    // Guardar en carpeta capturas/
    const ext      = file.name.split('.').pop();
    const filename = `captura_${Date.now()}.${ext}`;
    const fh  = await App.capturasHandle.getFileHandle(filename, { create: true });
    const wr  = await fh.createWritable();
    await wr.write(file);
    await wr.close();

    // Crear blob URL para mostrar en el editor (sesión actual)
    const blobUrl = URL.createObjectURL(file);

    // Insertar como bloque colapsable (details/summary) en el HTML
    const range = App.quill.getSelection(true);
    // Quill no soporta natively <details>, así que insertamos un marcador
    // y lo reemplazamos en el HTML final para exportación
    const placeholder = `[📸 Captura: ${filename}]`;
    App.quill.insertText(range.index, placeholder, { bold: false, italic: true, color: '#4a6cf7' }, 'user');

    // Guardar referencia en el proyecto
    if (!App.project.inline_screenshots) App.project.inline_screenshots = {};
    App.project.inline_screenshots[placeholder] = {
      filename,
      inserted_at: new Date().toISOString(),
      blob_url: blobUrl,
    };

    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    showToast(`Captura "${filename}" incrustada en el texto.`, 'success');

  } catch (err) {
    showToast('Error al insertar la captura: ' + err.message, 'error');
  }
}

/* ================================================================
   BÚSQUEDA POR DOI (Crossref API)
   ================================================================ */

async function fetchDOI() {
  const doi = document.getElementById('source-doi-search').value.trim();
  if (!doi) {
    showToast('Ingresa un DOI para buscar.', 'warning');
    return;
  }

  const btn = document.getElementById('btn-fetch-doi');
  btn.textContent = 'Buscando…';
  btn.disabled = true;

  try {
    const cleanDoi = doi.replace('https://doi.org/', '').replace('http://dx.doi.org/', '');
    const url  = `https://api.crossref.org/works/${encodeURIComponent(cleanDoi)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('DOI no encontrado en Crossref.');

    const data = await resp.json();
    const item = data.message;

    document.getElementById('source-title').value = (item.title && item.title[0]) || '';
    document.getElementById('source-doi').value   = cleanDoi;
    document.getElementById('source-year').value  = item.published?.['date-parts']?.[0]?.[0] || '';
    document.getElementById('source-journal').value = item['container-title']?.[0] || '';
    document.getElementById('source-pages').value = item.page || '';

    if (item.author && item.author.length > 0) {
      const authors = item.author.map(a => `${a.family || ''}, ${a.given || ''}`.trim());
      document.getElementById('source-authors').value = authors.join('; ');
    }

    // Detectar tipo
    const typeMap = { 'journal-article': 'journal', 'book': 'book', 'book-chapter': 'chapter' };
    document.getElementById('source-type').value = typeMap[item.type] || 'journal';

    showToast('Datos obtenidos de Crossref correctamente.', 'success');

  } catch (err) {
    showToast('No se encontró el DOI: ' + err.message, 'error');
  } finally {
    btn.textContent = 'Buscar';
    btn.disabled = false;
  }
}

/* ================================================================
   EXPORTACIÓN
   ================================================================ */

// --- PDF (usa el CSS de impresión definido en styles.css) ---
function exportToPDF() {
  window.print();
}

// --- Word (.docx) usando la librería docx ---
async function exportToDocx() {
  if (!window.docx) {
    showToast('Librería DOCX no disponible. Verifica tu conexión a internet.', 'error');
    return;
  }

  showToast('Generando documento Word…', 'success');

  const { Document, Paragraph, TextRun, HeadingLevel, Packer, AlignmentType } = window.docx;

  const title    = App.project.metadata.title || 'Sin título';
  const htmlText = App.quill.getText();
  const lines    = htmlText.split('\n').filter(l => l.trim());

  const paragraphs = lines.map(line => {
    return new Paragraph({ children: [new TextRun(line)], spacing: { after: 200 } });
  });

  // Bibliografía al final
  const bibParagraphs = [
    new Paragraph({ text: 'Bibliografía', heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
  ];

  App.project.sources.forEach(src => {
    const citation = formatCitation(src, '', src.citation_style || 'chicago-note');
    const cleanText = citation.replace(/<\/?em>/g, '').replace(/<[^>]+>/g, '');
    bibParagraphs.push(new Paragraph({
      children: [new TextRun(cleanText)],
      spacing: { after: 150 },
    }));
  });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE, spacing: { after: 300 } }),
        ...paragraphs,
        ...bibParagraphs,
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${slugify(title)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  showToast('Documento Word exportado.', 'success');
}

// --- Bibliografía en formato RIS (para Zotero) ---
function exportToRIS() {
  if (App.project.sources.length === 0) {
    showToast('No hay fuentes registradas para exportar.', 'warning');
    return;
  }

  const typeMap = {
    journal:    'JOUR',
    book:       'BOOK',
    chapter:    'CHAP',
    thesis:     'THES',
    conference: 'CONF',
    website:    'ELEC',
    report:     'RPRT',
  };

  let ris = '';

  App.project.sources.forEach(src => {
    ris += `TY  - ${typeMap[src.type] || 'GEN'}\n`;
    (src.authors || []).forEach(a => { ris += `AU  - ${a}\n`; });
    ris += `TI  - ${src.title || ''}\n`;
    ris += `PY  - ${src.year || ''}\n`;
    if (src.journal) ris += `JO  - ${src.journal}\n`;
    if (src.doi)     ris += `DO  - ${src.doi}\n`;
    if (src.pages)   ris += `SP  - ${src.pages}\n`;
    ris += `ER  - \n\n`;
  });

  const blob = new Blob([ris], { type: 'application/x-research-info-systems' });
  const title = App.project.metadata.title || 'documento';
  downloadBlob(blob, `${slugify(title)}_bibliografia.ris`, 'application/x-research-info-systems');
  showToast('Bibliografía exportada en formato RIS (compatible con Zotero).', 'success');
}

// --- Copia de seguridad del JSON ---
async function exportJSON() {
  await saveProject(); // guardar primero
  const payload = structuredClone(App.project);
  payload._signature = await signPayload(payload);
  const blob  = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const title = App.project.metadata.title || 'documento';
  downloadBlob(blob, `${slugify(title)}_respaldo.json`, 'application/json');
  showToast('Copia del proyecto descargada.', 'success');
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function downloadBlob(blob, filename, type) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function countWords(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

function updateWordCount(count) {
  document.getElementById('sb-word-count').textContent = `${count} palabras`;
}

function updateSaveStatus(state, isoDate) {
  const el   = document.getElementById('save-status');
  const text = document.getElementById('save-status-text');
  el.classList.remove('saving', 'unsaved', 'error');

  if (state === 'saving') {
    el.classList.add('saving');
    text.textContent = 'Guardando…';
  } else if (state === 'saved') {
    const t = isoDate ? new Date(isoDate).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
    text.textContent = `Guardado ${t}`;
  } else if (state === 'unsaved') {
    el.classList.add('unsaved');
    text.textContent = 'Sin guardar';
  } else if (state === 'error') {
    el.classList.add('error');
    text.textContent = 'Error al guardar';
  }
}

function generateId() {
  return 'src-' + Math.random().toString(36).slice(2, 11);
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(str) {
  return str.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9\-]/g,'').substring(0,60) || 'documento';
}

function typeLabel(type) {
  const map = { journal:'Artículo', book:'Libro', chapter:'Capítulo', thesis:'Tesis',
    conference:'Ponencia', website:'Web', report:'Reporte' };
  return map[type] || type;
}

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type} fade-in`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function restoreTheme() {
  const saved = localStorage.getItem('eots-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  App.ui.currentTheme = theme;
  localStorage.setItem('eots-theme', theme);
  document.getElementById('theme-icon-light').classList.toggle('hidden', theme === 'dark');
  document.getElementById('theme-icon-dark').classList.toggle('hidden', theme === 'light');
}

/* ================================================================
   EVENT LISTENERS
   ================================================================ */

function initEventListeners() {

  // Onboarding
  document.getElementById('onboard-new').addEventListener('click', () => openOrCreateProject('new'));
  document.getElementById('onboard-open').addEventListener('click', () => openOrCreateProject('open'));

  // Botón abrir carpeta (topbar)
  document.getElementById('btn-open-folder').addEventListener('click', () => openOrCreateProject('open'));

  // Toggle sidebars
  document.getElementById('btn-toggle-sources').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-sources');
    App.ui.sourcesPanelOpen = !App.ui.sourcesPanelOpen;
    sidebar.classList.toggle('collapsed', !App.ui.sourcesPanelOpen);
  });

  document.getElementById('btn-toggle-tele').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar-telemetry');
    App.ui.telePanelOpen = !App.ui.telePanelOpen;
    sidebar.classList.toggle('collapsed', !App.ui.telePanelOpen);
  });

  // Tema
  document.getElementById('btn-theme').addEventListener('click', () => {
    applyTheme(App.ui.currentTheme === 'light' ? 'dark' : 'light');
  });

  // Título del documento
  document.getElementById('doc-title-input').addEventListener('input', () => {
    App.ui.isDirty = true;
    updateSaveStatus('unsaved');
    document.title = `${document.getElementById('doc-title-input').value || 'Sin título'} — Eye on the Sky`;
  });

  // Menú de exportación
  const exportBtn  = document.getElementById('btn-export-menu');
  const exportMenu = document.getElementById('export-menu');

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu.classList.toggle('open');
  });

  document.addEventListener('click', () => exportMenu.classList.remove('open'));

  document.getElementById('export-pdf').addEventListener('click',  exportToPDF);
  document.getElementById('export-docx').addEventListener('click', exportToDocx);
  document.getElementById('export-ris').addEventListener('click',  exportToRIS);
  document.getElementById('export-json').addEventListener('click', exportJSON);

  // Agregar fuente
  document.getElementById('btn-add-source').addEventListener('click', () => openAddSourceModal());
  document.getElementById('btn-insert-citation').addEventListener('click', () => openCitationModal());
  document.getElementById('btn-insert-screenshot').addEventListener('click', insertScreenshotAtCursor);

  // Modal fuente
  document.getElementById('save-source').addEventListener('click', saveSource);
  document.getElementById('cancel-source').addEventListener('click', () => closeModal('modal-source-overlay'));
  document.getElementById('close-modal-source').addEventListener('click', () => closeModal('modal-source-overlay'));
  document.getElementById('btn-fetch-doi').addEventListener('click', fetchDOI);

  // Drop zone de captura en modal fuente
  const dropZone = document.getElementById('source-screenshot-dropzone');
  const fileInput = document.getElementById('source-screenshot-input');

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) previewScreenshot(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) previewScreenshot(fileInput.files[0]);
  });

  document.getElementById('remove-screenshot').addEventListener('click', () => {
    App.ui.pendingScreenshot = null;
    document.getElementById('screenshot-preview').classList.add('hidden');
    document.getElementById('source-screenshot-dropzone').classList.remove('hidden');
  });

  // Importar BibTeX
  document.getElementById('btn-parse-bibtex').addEventListener('click', importBibtex);

  // Modal cita
  document.getElementById('close-modal-citation').addEventListener('click', () => closeModal('modal-citation-overlay'));
  document.getElementById('cancel-citation').addEventListener('click', () => closeModal('modal-citation-overlay'));
  document.getElementById('insert-citation-btn').addEventListener('click', insertCitationIntoEditor);
  document.getElementById('citation-source-select').addEventListener('change', updateCitationPreview);
  document.getElementById('citation-page').addEventListener('input', updateCitationPreview);

  // Cerrar modales con Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['modal-source-overlay','modal-citation-overlay'].forEach(id => closeModal(id));
    }
  });

  // Guardar con Ctrl+S
  document.addEventListener('keydown', async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      await saveProject();
    }
  });

  // Guardado automático al cambiar de pestaña o minimizar ventana
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && App.ui.isDirty && App.dirHandle) {
      saveProject();
    }
  });

  // Aviso antes de cerrar si hay cambios
  window.addEventListener('beforeunload', (e) => {
    if (App.ui.isDirty && App.ui.projectLoaded) {
      if (App.dirHandle) saveProject();
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function previewScreenshot(file) {
  App.ui.pendingScreenshot = { file, previewUrl: URL.createObjectURL(file) };
  document.getElementById('screenshot-preview-img').src = App.ui.pendingScreenshot.previewUrl;
  document.getElementById('screenshot-preview').classList.remove('hidden');
  document.getElementById('source-screenshot-dropzone').classList.add('hidden');
}

/* ================================================================
   IMPORTACIÓN BIBTEX
   ================================================================ */

/**
 * Parsea una cadena BibTeX y devuelve un array de entradas.
 * Soporta múltiples entradas en el mismo texto (importación en lote).
 */
function parseBibtex(text) {
  const entries = [];
  // Dividir en bloques individuales por cada @tipo{
  const blocks = text.split(/(?=@\w+\s*\{)/).filter(b => /^@\w/.test(b.trim()));

  for (const block of blocks) {
    try {
      // Extraer tipo y clave
      const header = block.match(/^@(\w+)\s*\{\s*([^,\s]+)\s*,/);
      if (!header) continue;

      const type = header[1].toLowerCase();
      if (['string', 'preamble', 'comment'].includes(type)) continue;

      const key = header[2].trim();

      // Extraer cuerpo (todo después de la primera coma hasta el último })
      const commaIdx = block.indexOf(',', block.indexOf('{'));
      const lastBrace = block.lastIndexOf('}');
      if (commaIdx < 0 || lastBrace < 0) continue;
      const body = block.slice(commaIdx + 1, lastBrace);

      // Parsear campos: nombre = {valor} | "valor" | número
      const fields = {};
      // Regex que soporta un nivel de anidamiento de llaves
      const fieldRe = /(\w+)\s*=\s*(?:\{((?:[^{}]|\{[^{}]*\})*)\}|"([^"]*)"|([0-9]+))/g;
      let fm;
      while ((fm = fieldRe.exec(body)) !== null) {
        const fname = fm[1].toLowerCase();
        let   fval  = (fm[2] ?? fm[3] ?? fm[4] ?? '').trim();
        // Limpiar comandos LaTeX básicos y llaves sobrantes
        fval = fval
          .replace(/\\[`'^~"=.][{]?([a-zA-Z])[}]?/g, '$1') // acentos LaTeX
          .replace(/\\[a-zA-Z]+\{([^}]+)\}/g, '$1')          // comandos con arg
          .replace(/\\[a-zA-Z]+/g, '')                        // comandos sin arg
          .replace(/[{}]/g, '')
          .replace(/--/g, '–')
          .replace(/\s+/g, ' ')
          .trim();
        fields[fname] = fval;
      }

      entries.push({ type, key, fields });
    } catch (err) {
      console.warn('Error al parsear entrada BibTeX:', err);
    }
  }

  return entries;
}

/** Convierte una entrada BibTeX parseada al formato de fuente de la app */
function bibtexEntryToSource(entry) {
  const f = entry.fields;

  // Autores: "Apellido, Nombre and Apellido2, Nombre2"
  const authorsRaw = f.author || f.editor || '';
  const authors = authorsRaw
    .split(/ and /i)
    .map(a => a.trim())
    .filter(Boolean);

  const typeMap = {
    article:       'journal',
    book:          'book',
    incollection:  'chapter',
    inproceedings: 'conference',
    proceedings:   'conference',
    phdthesis:     'thesis',
    mastersthesis: 'thesis',
    misc:          'website',
    techreport:    'report',
    unpublished:   'report',
  };

  return {
    id:               generateId(),
    type:             typeMap[entry.type] || 'journal',
    title:            f.title || f.booktitle || '',
    authors,
    year:             parseInt(f.year) || null,
    doi:              f.doi || f.url || '',
    journal:          f.journal || f.booktitle || f.publisher || f.school || '',
    pages:            (f.pages || '').replace(/--/g, '-'),
    citation_style:   'chicago-note',
    screenshot_filename: null,
    cited_in_text:    false,
    added_at:         new Date().toISOString(),
    bibtex_key:       entry.key,
  };
}

/** Importa todas las entradas BibTeX del textarea al proyecto */
function importBibtex() {
  const raw      = document.getElementById('bibtex-input').value.trim();
  const resultEl = document.getElementById('bibtex-import-result');

  if (!raw) {
    resultEl.textContent = 'Pega al menos una entrada BibTeX primero.';
    resultEl.className = 'text-sm text-warning mt-1';
    return;
  }

  const entries = parseBibtex(raw);

  if (entries.length === 0) {
    resultEl.textContent = 'No se encontraron entradas BibTeX válidas. Verifica el formato.';
    resultEl.className = 'text-sm text-danger mt-1';
    return;
  }

  let added = 0;
  let skipped = 0;

  entries.forEach(entry => {
    // Evitar duplicados por clave BibTeX
    const exists = App.project.sources.some(s => s.bibtex_key === entry.key);
    if (exists) { skipped++; return; }

    App.project.sources.push(bibtexEntryToSource(entry));
    added++;
  });

  renderSourcesList();
  populateCitationSelect();
  updateTelemetryUI();
  App.ui.isDirty = true;
  updateSaveStatus('unsaved');

  // Limpiar textarea
  document.getElementById('bibtex-input').value = '';

  resultEl.textContent = `✓ ${added} fuente(s) importada(s)${skipped > 0 ? `, ${skipped} omitida(s) por duplicado` : ''}.`;
  resultEl.className = 'text-sm text-success mt-1';

  if (added > 0) {
    showToast(`${added} fuente(s) BibTeX importada(s).`, 'success');
    // No cerrar el modal si se importaron varias (el usuario puede querer revisar)
    if (entries.length === 1) closeModal('modal-source-overlay');
  }
}
