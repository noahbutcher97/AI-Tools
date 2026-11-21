// Windows restores ProgramFiles when it starts the child. Set the disposable
// installation within the test process before the unmodified CLI imports it.
const path = require("node:path");
const root = process.env.RELAY_RECEIVE_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error("Missing isolated receiver installation");
process.env.ProgramFiles = root;
