/**
 * Eye on the Sky — config.js
 * Configuración de la instalación de CADA docente (es el único archivo que hay que editar).
 *
 * WEB_APP_URL: la URL de tu Apps Script publicado como aplicación web (termina en /exec).
 *   - Vacía  → la app funciona sin servidor (solo en el dispositivo + paquete .zip).
 *   - Con URL → cada sesión de trabajo se registra como una fila en tu Google Sheets,
 *               los estudiantes inician sesión con carnet y contraseña, y las alertas
 *               se actualizan en vivo.
 */
window.EOTS_CONFIG = {
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbyTtptYbaFBxgFDHbr9WF2oMomNqIgwjDlSol6FC_-IlCcjDeUPdmAAGfzkxgIkdsYy4A/exec',

  SYNC_INTERVAL_S: 60,    // cada cuántos segundos (como máximo) se envía la sesión en curso
  POLL_STUDENT_S: 180,    // cada cuánto el estudiante consulta su estado (solo con la pestaña visible)
  POLL_TEACHER_S: 60,     // cada cuánto el docente consulta alertas nuevas (punto rojo)
};
