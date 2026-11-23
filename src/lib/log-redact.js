// What may go into a log line when something fails. Error messages of the database driver can carry values («Duplicate entry
// '4012345678' for key …»), and a message can mention a phone number or a token; none of that belongs in a log file.
export function redactForLog(message) {
  return String(message ?? '')
    .replace(/Duplicate entry '[^']*'/g, "Duplicate entry '[value]'")
    .replace(/(?:\+?98|0098|0)?9\d{9}\b/g, '[phone]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[token]');
}
