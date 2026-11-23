// Point the ordinary watch client at the disposable broker's directory and listener.
import { reportJob as report } from "../../../MCP-Servers/bridges/relay/completion-broker.mjs";

export const installationRoot = () => process.env.RELAY_FIXTURE_ROOT;
export const reportJob = (grant, op, event) => report(grant, op, event, { port: Number(process.env.RELAY_FIXTURE_BROKER_PORT) });
