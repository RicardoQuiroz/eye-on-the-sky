/**
 * Eye on the Sky — dashboard.js
 * Panel docente: procesa en lote los proyectos de los estudiantes (.zip o .json),
 * verifica capturas y firma, y muestra métricas y alertas.
 *
 * Las métricas y alertas se calculan con analytics.js, el MISMO módulo que usa el
 * editor del estudiante: lo que el estudiante ve en su panel "Actividad y Salud" es
 * exactamente lo que aparece aquí.
 */

'use strict';

/* ================================================================
   ESTADO DEL DASHBOARD
   ================================================================ */

const Dash = {
  students:   [],       // Array de proyectos parseados
  sortCol:    'student_name',
  sortAsc:    true,
  charts:     {},
  detailStudent: null,
};

const alertLevel = EOTS.alertLevel;
const KIND_COLORS = {
  typed: 'rgba(16,185,129,0.80)', notes: 'rgba(74,108,247,0.70)', quote: 'rgba(20,184,166,0.70)',
  ai: 'rgba(245,158,11,0.80)', paste: 'rgba(229,57,53,0.75)',
};

/* ================================================================
   INICIALIZACIÓN
   ================================================================ */

document.addEventListener('DOMContentLoaded', () => {
  initUploadZone();
  initEventListeners();
  restoreTheme();
});

function initUploadZone() {
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('json-file-input');

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') input.click(); });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    loadFiles(Array.from(e.dataTransfer.files));
  });

  input.addEventListener('change', () => { loadFiles(Array.from(input.files)); input.value = ''; });
}

function initEventListeners() {
  document.getElementById('dash-btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-export-report').addEventListener('click', exportCSV);
  document.getElementById('dash-search').addEventListener('input', renderTable);
  document.getElementById('dash-filter-alert').addEventListener('change', renderTable);
  document.getElementById('close-student-detail').addEventListener('click', () => {
    document.getElementById('student-detail').classList.add('hidden');
    Dash.detailStudent = null;
  });

  // Modal de Apps Script y correo masivo
  const btnOpenEmailModal = document.getElementById('btn-open-email-modal');
  if (btnOpenEmailModal) btnOpenEmailModal.addEventListener('click', openAppsScriptModal);
  const btnCloseEmailModal = document.getElementById('close-modal-email');
  if (btnCloseEmailModal) btnCloseEmailModal.addEventListener('click', closeAppsScriptModal);
  const modalEmailOverlay = document.getElementById('modal-email-apps-script');
  if (modalEmailOverlay) {
    modalEmailOverlay.addEventListener('click', (e) => {
      if (e.target === modalEmailOverlay) closeAppsScriptModal();
    });
  }
  const btnCopyScript = document.getElementById('btn-copy-apps-script');
  if (btnCopyScript) btnCopyScript.addEventListener('click', copyAppsScriptCode);
  const btnCopyAnalytics = document.getElementById('btn-copy-analytics');
  if (btnCopyAnalytics) btnCopyAnalytics.addEventListener('click', async () => {
    try {
      const code = await (await fetch('analytics.js')).text();
      await navigator.clipboard.writeText(code);
      showToast('✓ analytics.js copiado: pégalo en un archivo nuevo llamado "analytics" del Apps Script.', 'success');
    } catch (_) { showToast('No se pudo copiar: descarga analytics.js con el enlace.', 'warning'); }
  });

  const btnDetailSendEmail = document.getElementById('detail-send-email-btn');
  if (btnDetailSendEmail) btnDetailSendEmail.addEventListener('click', sendIndividualStudentEmail);

  const scrollTo = (id) => { const el = document.getElementById(id); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const btnSources = document.getElementById('detail-view-sources');
  if (btnSources) btnSources.addEventListener('click', () => scrollTo('section-detail-sources'));
  const btnSessions = document.getElementById('detail-view-sessions');
  if (btnSessions) btnSessions.addEventListener('click', () => scrollTo('section-detail-sessions'));

  // Ordenamiento por columna
  document.querySelectorAll('#students-table th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (Dash.sortCol === col) Dash.sortAsc = !Dash.sortAsc;
      else { Dash.sortCol = col; Dash.sortAsc = true; }
      renderTable();
    });
  });
}

/* ================================================================
   CARGA Y PARSEO DE ARCHIVOS (.zip con capturas o .json)
   ================================================================ */

async function loadFiles(files) {
  const projectFiles = files.filter(f => /\.(json|zip)$/i.test(f.name));
  if (projectFiles.length === 0) {
    showToast('Selecciona archivos .zip (paquete del proyecto) o .json.', 'warning');
    return;
  }

  showToast(`Cargando ${projectFiles.length} archivo(s)…`, 'success');

  const results = await Promise.allSettled(projectFiles.map(parseStudentFile));
  let loaded = 0;
  let errors = 0;

  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value) {
      // Un mismo proyecto (mismo id) cargado dos veces: se conserva la versión más reciente
      const key = r.value._key;
      const existingIdx = Dash.students.findIndex(s => s._key === key);
      if (existingIdx >= 0) {
        const prev = Dash.students[existingIdx];
        const newer = (Date.parse(r.value.metadata?.last_saved || '') || 0) >= (Date.parse(prev.metadata?.last_saved || '') || 0);
        // Si son iguales en fecha, preferir el paquete .zip (trae capturas verificables)
        if (newer || (r.value._isBundle && !prev._isBundle)) Dash.students[existingIdx] = r.value;
      } else {
        Dash.students.push(r.value);
      }
      loaded++;
    } else {
      errors++;
      console.warn(`Error en ${projectFiles[i].name}:`, r.reason);
      showToast(String(r.reason?.message || r.reason), 'error');
    }
  });

  showToast(`${loaded} proyecto(s) cargado(s).${errors > 0 ? ` ${errors} con error.` : ''}`, loaded > 0 ? 'success' : 'error');

  if (Dash.students.length > 0) {
    document.getElementById('dash-main').classList.remove('hidden');
    renderCourseStats();
    renderCharts();
    renderTable();
    const courses = [...new Set(Dash.students.map(s => s.metadata?.course).filter(Boolean))];
    document.getElementById('dash-course-label').textContent = courses.join(', ');
  }
}

async function sha256Hex(blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function parseStudentFile(file) {
  let parsed;
  let isBundle = false;
  const captureURLs = {};
  let verification = null;

  if (/\.zip$/i.test(file.name)) {
    if (!window.JSZip) throw new Error('No se pudo cargar el lector de .zip (revisa la conexión).');
    isBundle = true;
    const zip = await JSZip.loadAsync(file);
    const entry = zip.file('proyecto.json') || zip.file(/\.json$/i).find(f => !f.name.startsWith('capturas/'));
    if (!entry) throw new Error(`El paquete "${file.name}" no contiene proyecto.json.`);
    try { parsed = JSON.parse(await entry.async('string')); }
    catch (_) { throw new Error(`El paquete "${file.name}" contiene un JSON inválido.`); }

    // Verificar cada captura registrada contra su huella SHA-256
    const registry = parsed.captures || {};
    verification = { total: Object.keys(registry).length, ok: 0, missing: 0, mismatch: 0, unhashed: 0, replaced: 0, files: {} };
    for (const [filename, meta] of Object.entries(registry)) {
      const f = zip.file('capturas/' + filename);
      if (!f) { verification.missing++; verification.files[filename] = 'missing'; continue; }
      const blob = await f.async('blob');
      captureURLs[filename] = URL.createObjectURL(blob);
      if (!meta.sha256) { verification.unhashed++; verification.files[filename] = 'unhashed'; continue; }
      const sha = await sha256Hex(blob);
      if (sha === meta.sha256) { verification.ok++; verification.files[filename] = meta.replaced ? 'replaced' : 'ok'; }
      else { verification.mismatch++; verification.files[filename] = 'mismatch'; }
      if (meta.replaced) verification.replaced++;
    }
  } else {
    let text = '';
    try { text = await file.text(); }
    catch (readErr) { throw new Error(`No se pudo leer el archivo "${file.name}": ${readErr.message}`); }
    try { parsed = JSON.parse(text); }
    catch (parseErr) { throw new Error(`El archivo "${file.name}" contiene JSON inválido o corrupto.`); }
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`El archivo "${file.name}" no tiene una estructura de proyecto válida.`);
  }

  // Verificar firma de integridad
  parsed._integrity_ok = false;
  if (parsed._signature) {
    try { parsed._integrity_ok = await verifySignature(parsed); }
    catch (sigErr) { console.warn(`Error al verificar firma en "${file.name}":`, sigErr); }
  }

  parsed._filename = file.name;
  parsed._filesize = file.size;
  parsed._isBundle = isBundle;
  parsed._captureURLs = captureURLs;
  parsed._key = parsed.metadata?.project_id || ('legacy:' + (parsed.metadata?.created_at || file.name));
  parsed._loaded_at = new Date().toISOString();

  const m = EOTS.computeMetrics(parsed);
  if (!m.student_name) m.student_name = extractNameFromFilename(file.name);
  m.captures_verified = verification;
  m.integrity_ok = parsed._integrity_ok;
  m.is_bundle = isBundle;
  parsed._metrics = m;
  parsed._alerts  = EOTS.computeAlerts(m, { integrity_ok: parsed._integrity_ok });
  if (!isBundle && m.captures_registered > 0) {
    parsed._alerts.push({ level: 'info', code: 'no_bundle', message: 'Entregó solo el .json: las capturas no se pudieron verificar (pide el paquete .zip)' });
  }
  return parsed;
}

/* ================================================================
   ESTADÍSTICAS DEL CURSO
   ================================================================ */

function renderCourseStats() {
  const metrics = Dash.students.map(s => s._metrics);
  const n = metrics.length;
  const avg = key => {
    const vals = metrics.map(m => m[key]).filter(v => typeof v === 'number' && !isNaN(v));
    return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };
  const countAlerts = level => Dash.students.filter(s => alertLevel(s._alerts) === level).length;

  const stats = [
    { label: 'Estudiantes cargados',      value: n },
    { label: 'Sin alertas',               value: countAlerts('ok'),      color: 'var(--success)' },
    { label: 'Con advertencias',          value: countAlerts('warning'), color: 'var(--warning)' },
    { label: 'Con alertas críticas',      value: countAlerts('danger'),  color: 'var(--danger)' },
    { label: 'Promedio texto tecleado',   value: Math.round(avg('typed_share') * 100) + '%' },
    { label: 'Promedio pegado sin declarar', value: Math.round(avg('undeclared_share') * 100) + '%' },
    { label: 'Promedio sesiones',         value: avg('total_sessions').toFixed(1) },
    { label: 'Promedio palabras',         value: Math.round(avg('word_count')) },
  ];

  document.getElementById('course-stats-grid').innerHTML = stats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');
}

/* ================================================================
   GRÁFICOS (Chart.js)
   ================================================================ */

function chartTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return { gridColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)', textColor: isDark ? '#9ba3b8' : '#52596b' };
}

function provenanceShares(m) {
  if (m.provenance?.shares) return m.provenance.shares;
  // Archivos antiguos: solo se conoce tecleado vs. pegado sin declarar
  return { typed: m.typed_share, notes: 0, quote: 0, ai: 0, paste: 1 - m.typed_share };
}

function renderCharts() {
  if (!window.Chart) return;
  const metrics = Dash.students.map(s => s._metrics);
  const names   = metrics.map(m => shortName(m.student_name));

  Object.values(Dash.charts).forEach(c => c.destroy());
  Dash.charts = {};

  const { gridColor, textColor } = chartTheme();
  Chart.defaults.color  = textColor;
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.font.size   = 11;

  // Gráfico 1: procedencia del texto final por estudiante (apilado al 100 %)
  const kinds = ['typed', 'notes', 'quote', 'ai', 'paste'];
  const ctx1 = document.getElementById('chart-manual-vs-paste').getContext('2d');
  Dash.charts.manual = new Chart(ctx1, {
    type: 'bar',
    data: {
      labels: names,
      datasets: kinds.map(k => ({
        label: EOTS.PROVENANCE[k].label,
        data: metrics.map(m => Math.round((provenanceShares(m)[k] || 0) * 100)),
        backgroundColor: KIND_COLORS[k],
        borderRadius: 3,
      })),
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' }, tooltip: { mode: 'index', callbacks: { label: c => `${c.dataset.label}: ${c.raw}%` } } },
      scales: {
        x: { stacked: true, grid: { color: gridColor } },
        y: { stacked: true, max: 100, grid: { color: gridColor }, ticks: { callback: v => v + '%' } }
      }
    }
  });

  // Gráfico 2: sesiones y días por estudiante
  const ctx2 = document.getElementById('chart-sessions').getContext('2d');
  Dash.charts.sessions = new Chart(ctx2, {
    type: 'bar',
    data: {
      labels: names,
      datasets: [
        { label: 'Sesiones', data: metrics.map(m => m.total_sessions), backgroundColor: 'rgba(16,185,129,0.75)', borderRadius: 4 },
        { label: 'Días activos', data: metrics.map(m => m.total_days_active), backgroundColor: 'rgba(74,108,247,0.6)', borderRadius: 4 },
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { x: { grid: { color: gridColor } }, y: { beginAtZero: true, grid: { color: gridColor }, ticks: { precision: 0 } } }
    }
  });
}

/* ================================================================
   TABLA DE ESTUDIANTES
   ================================================================ */

function renderTable() {
  const search      = document.getElementById('dash-search').value.toLowerCase();
  const alertFilter = document.getElementById('dash-filter-alert').value;

  let data = Dash.students.filter(s => {
    const hay = `${s._metrics.student_name} ${s._metrics.student_email} ${s._metrics.doc_title}`.toLowerCase();
    if (search && !hay.includes(search)) return false;
    if (alertFilter && alertLevel(s._alerts) !== alertFilter) return false;
    return true;
  });

  data.sort((a, b) => {
    let va = a._metrics[Dash.sortCol];
    let vb = b._metrics[Dash.sortCol];
    if (va === null || va === undefined) va = -1;
    if (vb === null || vb === undefined) vb = -1;
    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    if (va < vb) return Dash.sortAsc ? -1 : 1;
    if (va > vb) return Dash.sortAsc ? 1  : -1;
    return 0;
  });

  const tbody = document.getElementById('students-table-body');
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align: center; padding: 32px; color: var(--text-muted);">No se encontraron resultados.</td></tr>`;
    return;
  }

  data.forEach(student => {
    const m     = student._metrics;
    const level = alertLevel(student._alerts);
    const tr    = document.createElement('tr');
    const shown = student._alerts.filter(a => a.level !== 'info');
    const capCell = m.captures_verified
      ? `${m.sources_with_screenshot} / ${m.sources_count}<div class="text-sm" style="font-size:0.7rem;color:${m.captures_verified.mismatch || m.captures_verified.missing ? 'var(--danger)' : 'var(--success)'};">${m.captures_verified.ok}/${m.captures_verified.total} verificadas</div>`
      : `${m.sources_with_screenshot} / ${m.sources_count}${m.captures_registered ? '<div class="text-sm" style="font-size:0.7rem;color:var(--text-muted);">sin verificar</div>' : ''}`;

    tr.innerHTML = `
      <td>
        <div style="font-weight: 600;">${student._nuevas && student._nuevas.length ? '<span class="row-dot" title="Alertas nuevas sin revisar">●</span> ' : ''}${escapeHtml(m.student_name)}${student._live ? ' <span class="text-sm" style="font-size:0.66rem;color:var(--success);">EN VIVO</span>' : ''}</div>
        <div class="text-sm text-muted" style="font-size: 0.73rem; margin-top: 1px;">${escapeHtml(m.doc_title)}</div>
        ${m.student_email ? `<div class="text-sm" style="font-size: 0.7rem; color: var(--accent);">${escapeHtml(m.student_email)}</div>` : ''}
      </td>
      <td><strong>${m.total_sessions}</strong><div class="text-sm text-muted" style="font-size:0.7rem;">${m.devices.length} disp.</div></td>
      <td>${m.total_days_active}</td>
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 50px; height: 6px; background: var(--border); border-radius: 99px; overflow: hidden;">
            <div style="height: 100%; width: ${Math.round(m.typed_share * 100)}%; background: ${ratioColor(m.typed_share)}; border-radius: 99px;"></div>
          </div>
          <span>${Math.round(m.typed_share * 100)}%</span>
        </div>
        ${m.measured_on_final_text ? '' : '<div class="text-sm text-muted" style="font-size:0.68rem;" title="Archivo de versión anterior: estimado por eventos">estimado</div>'}
      </td>
      <td style="color:${m.undeclared_share >= EOTS.POLICY.UNDECLARED_DANGER ? 'var(--danger)' : m.undeclared_share >= EOTS.POLICY.UNDECLARED_WARN ? 'var(--warning)' : 'inherit'}">${EOTS.pct(m.undeclared_share)}<div class="text-sm text-muted" style="font-size:0.7rem;">${m.pastes.paste.n} pegado(s)</div></td>
      <td>${capCell}</td>
      <td>${m.word_count.toLocaleString('es')}</td>
      <td>${renderBiometricBadge(m)}</td>
      <td>
        ${level === 'ok'
          ? '<span class="alert-badge alert-ok">✓ Sin alertas</span>'
          : `<span class="alert-badge alert-${level}" title="${escapeHtml(shown.map(a => a.message).join('\n'))}">
              ${level === 'danger' ? '⚠' : '!'} ${shown.length} alerta(s)
             </span>`}
        ${!m.integrity_ok ? '<span class="alert-badge alert-warning" title="El JSON pudo haber sido modificado manualmente" style="margin-top: 3px; display: block;">⚠ JSON modificado</span>' : ''}
      </td>
      <td>
        <button class="btn btn-sm btn-ghost" data-detail="${escapeHtml(student._key)}">Detalle</button>
      </td>
    `;
    tr.querySelector('[data-detail]').addEventListener('click', () => openDetail(student._key));
    tbody.appendChild(tr);
  });
}

function renderBiometricBadge(m) {
  if (!m.has_biometric_baseline) {
    const why = m.keyboard_words_typed > 0 ? 'Aún no se completa la calibración con teclado físico (250 pulsaciones)' : 'Trabajó solo en pantalla táctil: la biometría no aplica';
    return `<span class="alert-badge" style="background:var(--border); color:var(--text-muted); font-size:0.75rem;" title="${why}">Sin huella</span>`;
  }
  const score = m.biometric_worst ?? m.biometric_score ?? 100;
  const title = `Última: ${m.biometric_score ?? '—'}% · Mínima: ${m.biometric_worst ?? '—'}% · Permanencia ${m.biometric_dwell || '—'} ms · Vuelo ${m.biometric_flight || '—'} ms (indicador informativo)`;
  const lvl = EOTS.bioLevel(score);
  if (lvl === 'ok') return `<span class="alert-badge alert-ok" style="font-size:0.75rem;" title="${title}">✓ ${score}%</span>`;
  if (lvl === 'warning') return `<span class="alert-badge alert-warning" style="font-size:0.75rem;" title="${title}">! ${score}%</span>`;
  return `<span class="alert-badge alert-danger" style="font-size:0.75rem;" title="${title}">⚠ ${score}%</span>`;
}

/* ================================================================
   DETALLE DE ESTUDIANTE
   ================================================================ */

const KIND_LABEL = { notes: 'Notas propias', quote: 'Cita textual', ai: 'IA declarada', paste: 'Sin declarar' };
const sectionTitle = (t) => `<div style="font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 10px;">${t}</div>`;
const card = (inner, extra = '') => `<div style="margin-bottom: 16px; padding: 14px 16px; background: var(--bg-sidebar); border-radius: 8px; border: 1px solid var(--border); ${extra}">${inner}</div>`;

function showStudentDetail(key) {
  const student = Dash.students.find(s => s._key === key);
  if (!student) return;

  Dash.detailStudent = student;
  const m = student._metrics;

  document.getElementById('detail-student-name').textContent = m.student_name + (m.student_email ? ` · ${m.student_email}` : '');
  document.getElementById('detail-doc-title').textContent    = `${m.doc_title}  —  archivo: ${student._filename}`;

  const detailStats = [
    { label: 'Palabras en el documento', value: m.word_count.toLocaleString('es') },
    { label: 'Texto tecleado',      value: EOTS.pct(m.typed_share), color: ratioColor(m.typed_share) },
    { label: 'Pegado sin declarar', value: EOTS.pct(m.undeclared_share), color: m.undeclared_share >= EOTS.POLICY.UNDECLARED_WARN ? 'var(--danger)' : 'var(--success)' },
    { label: 'Sesiones / días',     value: `${m.total_sessions} / ${m.total_days_active}` },
    { label: 'Dispositivos',        value: m.devices.length },
    { label: 'Tasa de revisión',    value: m.process.revision_ratio === null ? '—' : EOTS.pct(m.process.revision_ratio) },
    { label: 'Fuentes con captura', value: `${m.sources_with_screenshot}/${m.sources_count}` },
    { label: 'Capturas verificadas', value: m.captures_verified ? `${m.captures_verified.ok}/${m.captures_verified.total}` : (m.captures_registered ? 'Sin paquete' : '—') },
  ];
  document.getElementById('detail-stats-grid').innerHTML = detailStats.map(s => `
    <div class="stat-card">
      <div class="stat-card-value" style="${s.color ? `color: ${s.color}` : ''}">${s.value}</div>
      <div class="stat-card-label">${s.label}</div>
    </div>
  `).join('');

  // ---- Alertas ----
  const levelStyle = { danger: 'danger', warning: 'warning', info: 'accent' };
  const alertsHTML = student._alerts.length > 0
    ? `<div style="margin-bottom: 16px;">${sectionTitle('Alertas e indicios (para conversar con el estudiante, no son prueba)')}
        ${student._alerts.map(a => `
          <div style="display: flex; gap: 8px; align-items: flex-start; margin-bottom: 6px; padding: 10px 12px; border-radius: 7px; background: var(--${levelStyle[a.level]}-light);">
            <span style="font-size: 0.9rem;">${a.level === 'danger' ? '⚠' : a.level === 'warning' ? '!' : 'ℹ'}</span>
            <span class="text-sm" style="color: var(--${levelStyle[a.level]}); font-weight: 500;">${escapeHtml(a.message)}</span>
          </div>`).join('')}
      </div>`
    : `<div style="padding: 12px; background: var(--success-light); border-radius: 7px; color: var(--success); font-size: 0.85rem; margin-bottom: 16px; font-weight: 500;">✓ Sin alertas.</div>`;

  // ---- Procedencia del texto final ----
  let provHTML = '';
  const sh = provenanceShares(m);
  const kinds = ['typed', 'notes', 'quote', 'ai', 'paste'];
  provHTML = card(`
    ${sectionTitle(m.measured_on_final_text ? 'Procedencia del texto final' : 'Procedencia estimada (archivo de versión anterior)')}
    <div style="display:flex;height:12px;border-radius:99px;overflow:hidden;background:var(--border);margin-bottom:10px;">
      ${kinds.filter(k => sh[k] > 0).map(k => `<span title="${EOTS.PROVENANCE[k].label}: ${EOTS.pct(sh[k])}" style="width:${(sh[k] * 100).toFixed(2)}%;background:${KIND_COLORS[k]}"></span>`).join('')}
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.8rem;">
      ${kinds.map(k => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${KIND_COLORS[k]};margin-right:4px;"></span>${EOTS.PROVENANCE[k].label}: <strong>${EOTS.pct(sh[k])}</strong></span>`).join('')}
    </div>`);

  // ---- Proceso de escritura ----
  const pr = m.process;
  const procHTML = pr.sessions_with_process ? card(`
    ${sectionTitle('Proceso de escritura (todas las sesiones)')}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;font-size:0.82rem;">
      <div>✍️ <strong>Caracteres tecleados:</strong><br>${pr.chars_typed.toLocaleString('es')}</div>
      <div>⌫ <strong>Tasa de revisión:</strong><br>${pr.revision_ratio === null ? '—' : EOTS.pct(pr.revision_ratio)} <span class="text-muted" style="font-size:0.72rem;">(componer suele estar entre 10 % y 40 %)</span></div>
      <div>↩️ <strong>Ediciones no lineales:</strong><br>${pr.nonlinear_per_1000 === null ? '—' : pr.nonlinear_per_1000.toFixed(1)} por cada 1000 car.</div>
      <div>⏸️ <strong>Pausas de reflexión (2–30 s):</strong><br>${pr.pauses_2s.toLocaleString('es')}</div>
      <div>⏱️ <strong>Tiempo de tecleo efectivo:</strong><br>${Math.round(pr.active_ms / 60000)} min</div>
    </div>
    <p class="text-sm text-muted" style="font-size:0.72rem;margin-top:8px;">Componer un texto propio implica borrar, volver atrás y pausar. Transcribir un texto ajeno de corrido produce muy pocas correcciones y casi ninguna edición no lineal. En pantallas táctiles el autocompletado altera estas cifras.</p>
  `) : '';

  // ---- Dispositivos ----
  const devHTML = m.devices.length ? card(`
    ${sectionTitle('Dispositivos utilizados')}
    ${m.devices.map(d => `<div style="font-size:0.82rem;margin-bottom:4px;">${d.class === 'touch' ? '📱' : '💻'} ${escapeHtml(d.label)} — ${d.sessions} sesión(es)</div>`).join('')}
  `) : '';

  // ---- Gráfico de crecimiento ----
  const growthHTML = card(`${sectionTitle('Crecimiento del documento en el tiempo')}<canvas id="chart-growth" height="110"></canvas>
    <p class="text-sm text-muted" style="font-size:0.72rem;margin-top:6px;">Línea verde: tamaño del documento. Barras rojas: caracteres que entraron por pegado. Un escalón vertical sin barra roja indica una inserción no registrada.</p>`);

  // ---- Pegados ----
  const allPastes = [];
  (student.telemetry?.sessions || []).forEach(s => (s.paste_events || []).forEach(p => allPastes.push({ ...p, _ses: s.session_number })));
  const pastesHTML = allPastes.length ? card(`
    ${sectionTitle(`Pegados registrados (${allPastes.length})`)}
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.78rem;">
      <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-muted);text-align:left;">
        <th style="padding:6px;">Ses.</th><th style="padding:6px;">Fecha</th><th style="padding:6px;">Tipo</th><th style="padding:6px;">Palabras</th><th style="padding:6px;">Fragmento</th></tr></thead>
      <tbody>${allPastes.map(p => {
        const k = EOTS.pasteKind(p);
        const src = p.source_id ? (student.sources || []).find(s => s.id === p.source_id) : null;
        return `<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:6px;">${p._ses || ''}</td>
          <td style="padding:6px;white-space:nowrap;">${p.timestamp ? new Date(p.timestamp).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
          <td style="padding:6px;"><span style="color:${KIND_COLORS[k]};font-weight:700;">${KIND_LABEL[k]}</span>${src ? `<br><span class="text-muted">${escapeHtml((src.authors?.[0] || '').split(',')[0])} ${escapeHtml(String(src.year || ''))}</span>` : ''}</td>
          <td style="padding:6px;">${p.approx_words || '—'}</td>
          <td style="padding:6px;color:var(--text-muted);">${p.excerpt ? escapeHtml(p.excerpt) : '<em>(sin fragmento: archivo antiguo)</em>'}</td>
        </tr>`;
      }).join('')}</tbody></table></div>`) : '';

  // ---- Huella biométrica ----
  const bio = student.biometrics || {};
  const b = bio.baselines?.keyboard || bio.baseline;
  const biometricsCardHTML = b ? card(`
    ${sectionTitle(`Ritmo de tecleo con teclado físico — indicador informativo (${b.sample_size || 250} pulsaciones)`)}
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; font-size: 0.82rem;">
      <div>⏱️ <strong>Permanencia media:</strong><br>${b.mean_dwell_ms} ms <span class="text-muted">(±${b.std_dwell_ms})</span></div>
      <div>⏸️ <strong>Pausa de vuelo:</strong><br>${b.mean_flight_ms} ms <span class="text-muted">(±${b.std_flight_ms})</span></div>
      <div>🔒 <strong>Consistencia última / mínima:</strong><br>${m.biometric_score ?? '—'}% / ${m.biometric_worst ?? '—'}%</div>
    </div>
    <p class="text-sm text-muted" style="font-size:0.72rem;margin-top:8px;">Con solo dos medias por sesión este indicador distingue mal entre personas y varía con el cansancio o el teclado. No lo uses como prueba de suplantación.</p>
  `) : '';

  // ---- Fuentes con miniatura y verificación de captura ----
  const verifyLabel = { ok: '✓ verificada', replaced: '⚠ reemplazada por el estudiante', mismatch: '✗ NO coincide con su huella', missing: '✗ falta en el paquete', unhashed: 'sin huella (versión anterior)' };
  const verifyColor = { ok: 'var(--success)', replaced: 'var(--warning)', mismatch: 'var(--danger)', missing: 'var(--danger)', unhashed: 'var(--text-muted)' };
  const sourcesHTML = (student.sources || []).length > 0
    ? `<div id="section-detail-sources" style="margin-top: 16px;">${sectionTitle(`Fuentes registradas (${student.sources.length})`)}
        ${student.sources.map(src => {
          const fn = src.screenshot_filename;
          const url = fn ? student._captureURLs[fn] : null;
          const vs = fn && m.captures_verified ? m.captures_verified.files[fn] : null;
          return `
          <div style="padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--bg-sidebar); display:flex; gap:12px;">
            ${url ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="Captura" style="width:96px;height:72px;object-fit:cover;border-radius:6px;border:1px solid var(--border);"></a>` : ''}
            <div style="flex:1;">
              <div style="font-size: 0.83rem; font-weight: 600;">${escapeHtml(src.title || 'Sin título')}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap;">
                <span>${escapeHtml((src.authors || []).join('; '))}</span>
                <span>${escapeHtml(String(src.year || '—'))}</span>
                ${src.doi ? `<span>DOI: ${escapeHtml(src.doi)}</span>` : ''}
                <span style="color: ${fn ? 'var(--success)' : 'var(--danger)'}">${fn ? '📸 Con captura' : '✗ Sin captura'}</span>
                ${vs ? `<span style="color:${verifyColor[vs]};font-weight:600;">${verifyLabel[vs]}</span>` : ''}
                <span style="color: ${src.cited_in_text ? 'var(--success)' : 'var(--text-muted)'}">${src.cited_in_text ? '✓ Citada en el texto' : 'Sin citar'}</span>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`
    : (student._live
        ? `<div id="section-detail-sources" class="text-sm text-muted" style="margin-top: 12px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px;">📚 ${m.sources_count} fuente(s) registradas, ${m.sources_with_screenshot} con captura. Las fuentes y capturas están en el dispositivo del estudiante: para verlas y verificar sus huellas, carga su <strong>paquete .zip</strong>.</div>`
        : `<div class="text-sm text-muted" style="margin-top: 12px;">El estudiante no registró fuentes bibliográficas.</div>`);

  // ---- Sesiones ----
  const sessions = student.telemetry?.sessions || [];
  const sessionsHTML = sessions.length > 0
    ? `<div id="section-detail-sessions" style="margin-top: 20px;">
        ${sectionTitle(`Historial de sesiones (${sessions.length})`)}
        <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 8px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 0.8rem;">
            <thead>
              <tr style="background: var(--bg-sidebar); border-bottom: 1px solid var(--border); color: var(--text-muted); text-align:left;">
                <th style="padding: 8px;">#</th><th style="padding: 8px;">Fecha y horario</th><th style="padding: 8px;">Dispositivo</th>
                <th style="padding: 8px;">Duración</th><th style="padding: 8px;">Palabras</th><th style="padding: 8px;">Tecleadas</th>
                <th style="padding: 8px;">Pegados (decl./sin decl.)</th><th style="padding: 8px;">Revisión</th><th style="padding: 8px;">Biometría</th>
              </tr>
            </thead>
            <tbody>
              ${sessions.map((s, idx) => {
                const sDate = s.start_time ? new Date(s.start_time).toLocaleDateString('es') : (s.date || '—');
                const t1 = s.start_time ? new Date(s.start_time).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
                const t2 = s.end_time ? new Date(s.end_time).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) : '';
                const net = (s.words_net_change !== undefined) ? s.words_net_change : ((s.final_word_count || 0) - (s.initial_word_count || 0));
                const pe = s.paste_events || [];
                const decl = pe.filter(p => EOTS.pasteKind(p) !== 'paste').length;
                const undecl = pe.length - decl;
                const rev = s.process && s.process.chars_typed > 0 ? EOTS.pct(s.process.chars_deleted / s.process.chars_typed) : '—';
                const sb = s.biometrics || {};
                let bioCell = '<span style="color:var(--text-muted);">—</span>';
                if (sb.not_applicable || s.device?.class === 'touch') bioCell = '<span style="color:var(--text-muted);">No aplica (táctil)</span>';
                else if (typeof sb.similarity_score === 'number' && (sb.samples || 0) >= EOTS.POLICY.BIO_MIN_SAMPLES) {
                  const lvl = EOTS.bioLevel(sb.similarity_score);
                  const color = lvl === 'ok' ? 'var(--success)' : lvl === 'warning' ? 'var(--warning)' : 'var(--danger)';
                  bioCell = `<span style="color:${color}; font-weight:600;" title="Muestras: ${sb.samples}">${sb.similarity_score}%</span>`;
                }
                return `
                  <tr style="border-bottom: 1px solid var(--border);">
                    <td style="padding: 8px; font-weight: 600; color: var(--primary);">${s.session_number || (idx + 1)}</td>
                    <td style="padding: 8px; white-space:nowrap;">${sDate}<br><span class="text-muted">${t1}${t2 ? ' – ' + t2 : ''}</span></td>
                    <td style="padding: 8px;">${s.device ? escapeHtml(s.device.label) : '<span class="text-muted">—</span>'}</td>
                    <td style="padding: 8px;">${s.duration_minutes ? s.duration_minutes + ' min' : '—'}${s.active_minutes !== undefined ? `<br><span class="text-muted">${s.active_minutes} activos</span>` : ''}</td>
                    <td style="padding: 8px;">${s.initial_word_count || 0} ➔ <strong>${s.final_word_count || 0}</strong> <span style="color:${net >= 0 ? 'var(--success)' : 'var(--danger)'};">(${net > 0 ? '+' : ''}${net})</span></td>
                    <td style="padding: 8px;">${s.words_typed || 0}</td>
                    <td style="padding: 8px;">${decl} / <span style="color:${undecl ? 'var(--danger)' : 'inherit'};">${undecl}</span></td>
                    <td style="padding: 8px;">${rev}</td>
                    <td style="padding: 8px;">${bioCell}</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`
    : `<div class="text-sm text-muted" style="margin-top: 16px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px;">No hay registros de sesiones en este archivo.</div>`;

  document.getElementById('detail-tabs-content').innerHTML =
    alertsHTML + provHTML + growthHTML + procHTML + pastesHTML + devHTML + biometricsCardHTML + sourcesHTML + sessionsHTML;

  renderGrowthChart(student);

  document.getElementById('student-detail').classList.remove('hidden');
  document.getElementById('student-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Tamaño del documento a lo largo del tiempo (todas las sesiones) con los pegados marcados. */
function renderGrowthChart(student) {
  const canvas = document.getElementById('chart-growth');
  if (!canvas || !window.Chart) return;
  if (Dash.charts.growth) { Dash.charts.growth.destroy(); delete Dash.charts.growth; }

  const size = [];
  const pastes = [];
  (student.telemetry?.sessions || []).forEach(s => {
    const start = Date.parse(s.start_time || '') || 0;
    if (Array.isArray(s.timeline) && s.timeline.length) {
      s.timeline.forEach(pt => size.push({ x: start + pt[0] * 1000, y: pt[1] }));
    } else {
      // Archivos antiguos: solo inicio y fin de la sesión (en palabras × 6 ≈ caracteres)
      if (start) size.push({ x: start, y: (s.initial_word_count || 0) * 6 });
      const end = Date.parse(s.end_time || '') || start;
      if (end) size.push({ x: end, y: (s.final_word_count || 0) * 6 });
    }
    (s.paste_events || []).forEach(p => {
      const t = Date.parse(p.timestamp || '');
      if (t) pastes.push({ x: t, y: p.chars_pasted || 0, kind: EOTS.pasteKind(p) });
    });
  });
  if (!size.length) return;
  size.sort((a, b) => a.x - b.x);

  const { gridColor } = chartTheme();
  const fmt = v => new Date(v).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  Dash.charts.growth = new Chart(canvas.getContext('2d'), {
    data: {
      datasets: [
        { type: 'line', label: 'Caracteres en el documento', data: size, borderColor: 'rgba(16,185,129,0.9)', backgroundColor: 'rgba(16,185,129,0.15)', pointRadius: 0, stepped: false, tension: 0.1, fill: true, spanGaps: false },
        { type: 'bar', label: 'Pegado (caracteres)', data: pastes, backgroundColor: pastes.map(p => KIND_COLORS[p.kind]), barThickness: 4 },
      ]
    },
    options: {
      responsive: true,
      parsing: false,
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { title: items => fmt(items[0].parsed.x) } } },
      scales: {
        x: { type: 'linear', grid: { color: gridColor }, ticks: { callback: v => fmt(v), maxTicksLimit: 6 } },
        y: { beginAtZero: true, grid: { color: gridColor } }
      }
    }
  });
}

/* ================================================================
   EXPORTAR REPORTE CSV (para Google Sheets / Excel y el Apps Script)
   ================================================================ */

function csvRow(m, s) {
  const sh = provenanceShares(m);
  const shown = s._alerts.filter(a => a.level !== 'info' || ['ai_present', 'no_bundle'].includes(a.code));
  return [
    m.student_name,
    m.student_email || '',
    m.project_id || '',
    m.doc_title,
    m.total_sessions,
    m.total_days_active,
    m.devices.map(d => d.label).join(' / '),
    m.word_count,
    Math.round(m.typed_share * 100) + '%',
    Math.round(m.undeclared_share * 100) + '%',
    Math.round((sh.notes || 0) * 100) + '%',
    Math.round((sh.quote || 0) * 100) + '%',
    Math.round((sh.ai || 0) * 100) + '%',
    m.pastes.paste.n,
    m.pastes.notes.n + m.pastes.quote.n + m.pastes.ai.n,
    m.process.revision_ratio === null ? 'N/A' : Math.round(m.process.revision_ratio * 100) + '%',
    Math.round((m.process.active_ms || 0) / 60000),
    m.sources_count,
    m.sources_with_screenshot,
    m.sources_cited_in_text,
    m.captures_verified ? `${m.captures_verified.ok}/${m.captures_verified.total}` : (m.captures_registered ? 'Sin paquete' : 'N/A'),
    m.has_biometric_baseline ? 'CALIBRADA' : 'SIN HUELLA',
    m.biometric_score !== null && m.biometric_score !== undefined ? m.biometric_score + '%' : 'N/A',
    m.biometric_worst !== null && m.biometric_worst !== undefined ? m.biometric_worst + '%' : 'N/A',
    alertLevel(s._alerts),
    shown.map(a => a.message).join(' | '),
    m.integrity_ok ? 'OK' : 'MODIFICADO',
    m.last_saved ? new Date(m.last_saved).toLocaleString('es') : '',
  ];
}

const CSV_HEADERS = [
  'Estudiante', 'Correo', 'ID proyecto', 'Título del documento', 'Sesiones', 'Días activos', 'Dispositivos',
  'Total palabras', '% Tecleado', '% Pegado sin declarar', '% Notas declaradas', '% Citas textuales', '% IA declarada',
  'Pegados sin declarar', 'Pegados declarados', 'Tasa de revisión', 'Minutos de tecleo',
  'Fuentes totales', 'Fuentes con captura', 'Fuentes citadas en texto', 'Capturas verificadas',
  'Huella biométrica', 'Biometría última (%)', 'Biometría mínima (%)',
  'Nivel de alerta', 'Alertas', 'Integridad JSON', 'Último guardado',
];

function exportCSV() {
  if (Dash.students.length === 0) {
    showToast('No hay datos cargados para exportar.', 'warning');
    return;
  }
  const rows = Dash.students.map(s => csvRow(s._metrics, s).map(v => `"${String(v ?? '').replace(/"/g, '""')}"`));
  const csv  = [CSV_HEADERS.map(h => `"${h}"`).join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM para Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `reporte_curso_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  const noEmail = Dash.students.filter(s => !s._metrics.student_email).length;
  showToast(noEmail ? `Reporte CSV exportado. ${noEmail} estudiante(s) sin correo: el Apps Script los buscará en la hoja "Estudiantes" por nombre.` : 'Reporte CSV exportado.', noEmail ? 'warning' : 'success');
}

/* ================================================================
   FIRMA DE INTEGRIDAD (igual que en editor.js)
   ================================================================ */

function safeClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (e) { /* fallback */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

async function verifySignature(payload) {
  const stored = payload._signature;
  if (!stored) return false;
  const clone = safeClone(payload);
  delete clone._signature;
  // Las claves auxiliares que agrega el dashboard (prefijo "_") no forman parte de la firma
  Object.keys(clone).forEach(k => { if (k.startsWith('_')) delete clone[k]; });
  const secret = 'EyeOnTheSky-v1-integrity';
  const data   = secret + JSON.stringify(clone);
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  const expected = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return stored === expected;
}

/* ================================================================
   UTILIDADES
   ================================================================ */

function shortName(name) {
  if (!name) return '—';
  const parts = name.split(' ');
  return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1]}` : name;
}

function extractNameFromFilename(filename) {
  return (filename || 'Estudiante').replace(/\.(json|zip)$/i, '').replace(/_(paquete|respaldo)$/i, '').replace(/[_-]+/g, ' ');
}

function ratioColor(ratio) {
  if (ratio >= EOTS.POLICY.TYPED_WARN) return 'var(--success)';
  if (ratio >= EOTS.POLICY.TYPED_DANGER) return 'var(--warning)';
  return 'var(--danger)';
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type} fade-in`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 5000);
}

function restoreTheme() {
  const saved = localStorage.getItem('eots-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('eots-theme', theme);
  document.getElementById('dash-theme-icon-light').classList.toggle('hidden', theme === 'dark');
  document.getElementById('dash-theme-icon-dark').classList.toggle('hidden', theme === 'light');
  if (Dash.students.length > 0) renderCharts();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'light' ? 'dark' : 'light');
}

/* ================================================================
   REGISTRO DEL CURSO EN VIVO (Google Sheets + Apps Script)
   El panel pregunta periódicamente al servidor (Apps Script no puede "empujar" datos):
   la tabla, los gráficos y el punto rojo se actualizan sin recargar la página.
   ================================================================ */

function showModal(el) { el.classList.remove('hidden'); requestAnimationFrame(() => el.classList.add('open')); }
function hideModal(el) { el.classList.remove('open'); setTimeout(() => el.classList.add('hidden'), 200); }

const Live = {
  url: '', key: '', timer: null, connected: false, lastError: null,
  init() {
    try {
      this.url = localStorage.getItem('eots-live-url') || (window.EOTS_CONFIG && EOTS_CONFIG.WEB_APP_URL) || '';
      this.key = localStorage.getItem('eots-teacher-key') || '';
    } catch (_) {}
    document.getElementById('btn-live')?.addEventListener('click', () => this.openModal());
    document.getElementById('live-cancel')?.addEventListener('click', () => hideModal(document.getElementById('modal-live')));
    document.getElementById('live-connect')?.addEventListener('click', () => this.connectFromModal());
    document.getElementById('live-disconnect')?.addEventListener('click', () => this.disconnect());
    if (this.url && this.key) this.start();
    else this.renderIndicator();
  },
  openModal() {
    document.getElementById('live-url').value = this.url;
    document.getElementById('live-key').value = this.key;
    document.getElementById('live-error').textContent = '';
    showModal(document.getElementById('modal-live'));
  },
  async post(body) {
    // Google a veces devuelve una página de error pasajera (404/5xx): reintentar.
    let last = null;
    for (const d of [0, 1500, 4000]) {
      if (d) await new Promise(r => setTimeout(r, d));
      try {
        const res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow', credentials: 'omit', cache: 'no-store' });
        if (!res.ok) throw new Error('El servidor respondió ' + res.status);
        const txt = await res.text();
        try { return JSON.parse(txt); } catch (_) { throw new Error('El servidor devolvió una página de error de Google'); }
      } catch (e) { last = e; if (!navigator.onLine) break; }
    }
    const m = this.url.match(/\/s\/([^/]+)\//);
    throw new Error(last.message + (m ? ' (servidor …' + m[1].slice(-6) + ')' : '') + '. Inténtalo de nuevo en un minuto.');
  },
  async connectFromModal() {
    const url = document.getElementById('live-url').value.trim();
    const key = document.getElementById('live-key').value.trim();
    const err = document.getElementById('live-error');
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { err.textContent = 'La URL debe ser la de tu aplicación web de Apps Script (…/exec).'; return; }
    if (/\/dev\/?$/.test(url)) { err.textContent = 'Esa es la URL de PRUEBA (/dev), que solo funciona dentro de tu sesión de Google. Usa la de Implementar › Gestionar implementaciones (termina en /exec).'; return; }
    this.url = url; this.key = key;
    try {
      const r = await this.post({ action: 'docente_resumen', teacher_key: key, solo_alertas: true });
      if (!r.ok) { err.textContent = r.error || 'No se pudo conectar.'; return; }
    } catch (e) {
      const cfg = (window.EOTS_CONFIG && EOTS_CONFIG.WEB_APP_URL) || '';
      err.textContent = 'No se pudo conectar (' + e.message + '). Verifica que la URL sea la de Implementar › Gestionar implementaciones, con acceso "Cualquier usuario".' +
        (cfg && cfg !== url ? ' Esta URL es distinta a la de config.js: prueba con esa.' : '');
      return;
    }
    try { localStorage.setItem('eots-live-url', url); localStorage.setItem('eots-teacher-key', key); } catch (_) {}
    hideModal(document.getElementById('modal-live'));
    showToast('✓ Conectado al registro del curso.', 'success');
    this.start();
  },
  disconnect() {
    try { localStorage.removeItem('eots-teacher-key'); } catch (_) {}
    this.key = ''; this.connected = false;
    clearInterval(this.timer); this.timer = null;
    Dash.students = Dash.students.filter(s => !s._live);
    hideModal(document.getElementById('modal-live'));
    this.renderIndicator();
    refreshAllViews();
    showToast('Desconectado del registro en vivo.', 'info');
  },
  start() {
    this.refresh();
    clearInterval(this.timer);
    const every = ((window.EOTS_CONFIG && EOTS_CONFIG.POLL_TEACHER_S) || 60) * 1000;
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh(); }, every);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.key) this.refresh(); });
  },
  async refresh() {
    try {
      const r = await this.post({ action: 'docente_resumen', teacher_key: this.key });
      if (!r.ok) {
        this.lastError = r.error; this.connected = false; this.renderIndicator();
        showToast('Registro en vivo: ' + (r.error || 'error del servidor') + ' Pulsa "En vivo" para revisar la clave.', 'error');
        return;
      }
      this.connected = true; this.lastError = null; this.lastAt = new Date();
      const prev = new Map(Dash.students.filter(s => s._live).map(s => [s._key, s]));
      const live = (r.students || []).filter(x => x.metrics).map(x => {
        const old = prev.get('live:' + x.carnet);
        const m = { ...x.metrics, student_name: x.nombre || x.metrics.student_name, student_email: x.correo || x.metrics.student_email,
                    integrity_ok: true, captures_verified: null, is_bundle: false,
                    sessions: old && old._detailLoaded ? old.telemetry.sessions : [] };
        return {
          _key: 'live:' + x.carnet, _live: true, _carnet: x.carnet, _filename: 'Registro del curso (Google Sheets)',
          _captureURLs: {}, _integrity_ok: true, _nuevas: x.nuevas || [], _updated: x.updated,
          _detailLoaded: !!(old && old._detailLoaded),
          metadata: { title: m.doc_title, project_id: m.project_id, last_saved: m.last_saved },
          telemetry: { sessions: m.sessions }, sources: [], biometrics: {},
          _metrics: m, _alerts: x.alerts || [],
        };
      });
      Dash.students = Dash.students.filter(s => !s._live).concat(live);
      this.renderBanner(r);
      this.renderIndicator();
      refreshAllViews();
    } catch (e) {
      this.lastError = e.message; this.connected = false; this.renderIndicator();
      showToast('Registro en vivo: no se pudo conectar (' + e.message + ').', 'error');
    }
  },
  renderIndicator() {
    const dot = document.getElementById('live-indicator');
    const label = document.getElementById('live-label');
    if (dot) dot.style.background = this.connected ? 'var(--success)' : (this.key ? 'var(--danger)' : 'var(--text-muted)');
    if (label) label.textContent = this.connected
      ? `En vivo · ${this.lastAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`
      : (this.key ? 'En vivo (sin conexión)' : 'En vivo');
    document.getElementById('upload-zone')?.classList.toggle('compact', !!this.connected);
    const nuevas = Dash.students.filter(s => s._live && s._nuevas.length).length;
    document.querySelectorAll('.teacher-dot').forEach(d => d.classList.toggle('visible', nuevas > 0));
  },
  renderBanner(r) {
    const banner = document.getElementById('live-banner');
    const inactive = document.getElementById('live-inactive');
    const nuevas = r.nuevas_alertas || [];
    if (banner) {
      banner.classList.toggle('hidden', nuevas.length === 0);
      banner.innerHTML = nuevas.length
        ? `<div style="font-weight:700;color:var(--danger);margin-bottom:6px;">🔴 Alertas nuevas (${nuevas.length} estudiante(s))</div>` +
          nuevas.map(n => `<div class="text-sm" style="margin-bottom:4px;"><a href="#" data-live-open="live:${escapeHtml(n.carnet)}" style="color:var(--danger);font-weight:600;">${escapeHtml(n.nombre)}</a>: ${escapeHtml(n.mensajes.join(' · '))}</div>`).join('')
        : '';
      banner.querySelectorAll('[data-live-open]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); openDetail(a.getAttribute('data-live-open')); }));
    }
    if (inactive) {
      // Estado de la conexión SIEMPRE visible (aunque todavía no haya sesiones registradas)
      const sin = r.sin_actividad || [];
      const con = (r.students || []).filter(x => x.metrics).length;
      const total = con + sin.length;
      inactive.classList.remove('hidden');
      inactive.innerHTML = `
        <div style="padding: 12px 16px; border-radius: 10px; background: var(--bg-surface); border: 1px solid var(--border);">
          <div style="font-weight: 700; color: var(--success); margin-bottom: 4px;">● Conectado al registro del curso · ${this.lastAt.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })} (se actualiza solo cada ${(window.EOTS_CONFIG && EOTS_CONFIG.POLL_TEACHER_S) || 60} s)</div>
          <div class="text-sm">${total === 0
            ? '⚠ La hoja "Estudiantes" está vacía o sin estudiantes activos. Pega tu lista (Carnet, Estudiante, Correo) y genera las contraseñas.'
            : `${total} estudiante(s) en la lista · <strong>${con}</strong> con sesiones registradas · <strong>${sin.length}</strong> sin actividad todavía.`}</div>
          ${con === 0 && total > 0 ? '<div class="text-sm text-muted" style="margin-top: 4px;">La tabla y los gráficos aparecerán cuando el primer estudiante inicie sesión en el editor y trabaje (su sesión se envía en menos de un minuto).</div>' : ''}
          ${sin.length ? `<div class="text-sm text-muted" style="margin-top: 4px;">Sin actividad: ${sin.map(x => escapeHtml(x.nombre)).join(', ')}</div>` : ''}
        </div>`;
    }
  },
  async loadDetail(student) {
    const r = await this.post({ action: 'docente_detalle', teacher_key: this.key, carnet: student._carnet });
    if (!r.ok) throw new Error(r.error || 'No se pudo cargar el detalle');
    student.telemetry.sessions = r.sessions || [];
    student._metrics.sessions = student.telemetry.sessions;
    student._detailLoaded = true;
    // Al revisar el detalle, sus alertas quedan como vistas (se apaga el punto rojo)
    if (student._nuevas.length) {
      this.post({ action: 'docente_visto', teacher_key: this.key, carnet: student._carnet }).catch(() => {});
      student._nuevas = [];
      this.renderIndicator();
      renderTable();
    }
  },
};

function refreshAllViews() {
  const main = document.getElementById('dash-main');
  if (Dash.students.length === 0) { main.classList.add('hidden'); return; }
  main.classList.remove('hidden');
  renderCourseStats();
  renderCharts();
  renderTable();
}

async function openDetail(key, opts = {}) {
  const student = Dash.students.find(s => s._key === key);
  if (!student) return;
  if (student._live && !student._detailLoaded) {
    try { await Live.loadDetail(student); }
    catch (e) { showToast(e.message, 'error'); return; }
  }
  const y = window.scrollY;
  showStudentDetail(key);
  if (opts.keepScroll) window.scrollTo(0, y);
}

document.addEventListener('DOMContentLoaded', () => Live.init());

/* ================================================================
   INTEGRACIÓN GOOGLE APPS SCRIPT Y CORREO MASIVO
   ================================================================ */

let cachedAppsScriptCode = '';

async function loadAppsScriptCodeText() {
  if (cachedAppsScriptCode) return cachedAppsScriptCode;
  try {
    const res = await fetch('codigo_apps_script.gs');
    if (res.ok) {
      cachedAppsScriptCode = await res.text();
      return cachedAppsScriptCode;
    }
  } catch (e) {
    // Si fetch falla por protocolo file://, cargamos fallback seguro
  }
  cachedAppsScriptCode = `// 🛰️ EYE ON THE SKY — Google Apps Script (Envío masivo desde Google Sheets)
// Consulta el archivo completo 'codigo_apps_script.gs' en la carpeta raíz del proyecto.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎓 Eye on the Sky')
    .addItem('📧 Enviar reportes gráficos a estudiantes', 'enviarReportesEstudiantes')
    .addItem('👁️ Vista previa del correo', 'previsualizarCorreoFila')
    .addToUi();
}
// Descarga el archivo 'codigo_apps_script.gs' desde el botón de la ventana modal para ver el código completo.`;
  return cachedAppsScriptCode;
}

async function openAppsScriptModal() {
  const modal = document.getElementById('modal-email-apps-script');
  if (!modal) return;
  showModal(modal);

  const codeEl = document.getElementById('code-snippet-apps-script');
  if (codeEl) {
    const code = await loadAppsScriptCodeText();
    codeEl.textContent = code;
  }
}

function closeAppsScriptModal() {
  const modal = document.getElementById('modal-email-apps-script');
  if (modal) hideModal(modal);
}

async function copyAppsScriptCode() {
  const code = await loadAppsScriptCodeText();
  let copied = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch (clipErr) {
      console.debug('navigator.clipboard falló, intentando método fallback:', clipErr);
    }
  }

  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = code;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      textarea.style.top = '0';
      textarea.setAttribute('readonly', '');
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (err) {
      console.warn('Fallback de copia falló:', err);
    }
  }

  if (copied) {
    showToast('✓ ¡Código de Apps Script copiado al portapapeles!', 'success');
  } else {
    showToast('Por favor selecciona el texto en el recuadro inferior para copiarlo manualmente o descarga el archivo .gs', 'info');
  }
}

function sendIndividualStudentEmail() {
  const student = Dash.detailStudent;
  if (!student) {
    showToast('Por favor selecciona un estudiante primero.', 'warning');
    return;
  }

  const m = student._metrics;
  const nombre = m.student_name || 'Estudiante';
  const sh = provenanceShares(m);
  const shown = student._alerts.filter(a => a.level !== 'info' || a.code === 'ai_present');
  const alertas = shown.length
    ? shown.map(a => `• ${a.message}`).join('\n')
    : '• Sin observaciones. Proceso incremental y consistente.';

  const subject = `[Eye on the Sky] Retroalimentación de tu trabajo — ${nombre}`;
  const body = `Estimado/a ${nombre},

Te comparto el estado del seguimiento de tu trabajo "${m.doc_title}":

📊 RESUMEN (todas tus sesiones y dispositivos):
• Palabras en el documento: ${m.word_count.toLocaleString('es')}
• Sesiones: ${m.total_sessions} en ${m.total_days_active} día(s) · ${m.devices.length} dispositivo(s)
• Texto tecleado por ti: ${EOTS.pct(m.typed_share)}
• Notas propias declaradas: ${EOTS.pct(sh.notes)} · Citas textuales: ${EOTS.pct(sh.quote)} · IA declarada: ${EOTS.pct(sh.ai)}
• Pegado sin declarar: ${EOTS.pct(m.undeclared_share)}
• Fuentes con captura de evidencia: ${m.sources_with_screenshot} de ${m.sources_count}

🔍 OBSERVACIONES:
${alertas}

Puedes ver estas mismas cifras en el panel "Actividad y Salud" del editor.

Saludos cordiales,
Docente del Seminario de Investigación`;

  const to = m.student_email ? encodeURIComponent(m.student_email) : '';
  const mailtoUrl = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const link = document.createElement('a');
  link.href = mailtoUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast(m.student_email ? `Abriendo correo para ${m.student_email}…` : `El estudiante no registró correo: completa el destinatario.`, 'info');
}
