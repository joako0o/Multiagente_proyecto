// Precarga para `npm test`: silencia el logger sin depender de la sintaxis de
// variables de entorno de cada shell (VAR=x no existe en cmd.exe).
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
