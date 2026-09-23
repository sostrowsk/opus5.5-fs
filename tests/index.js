// Einstieg für `node --test tests/`: Node ≥ 23 wertet das Verzeichnis-Argument als Modul aus
// (tests/ → tests/index.js). Hier werden alle Testdateien geladen. `node --test` ohne Argument
// findet die *.test.mjs-Dateien ebenfalls direkt.
require('./math.test.mjs');
require('./heightfield.test.mjs');
require('./physics.test.mjs');
require('./input.test.mjs');
require('./audio.test.mjs');
require('./world.test.mjs');
require('./loop.test.mjs');
require('./head.test.mjs');
require('./pattern.test.mjs');
require('./ui.test.mjs');
