<?php

return [
    // Binary that runs bootstrap/loro-worker.cjs. Empty: `node` in
    // development, or the Electron binary inside the packaged app.
    'node_binary' => env('YEIDLE_NODE_BINARY', ''),
];
