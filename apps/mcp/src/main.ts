import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {createBridgeTransport} from './bridge.js';
import {loadMcpConfig} from './config.js';
import {createLocalMcpServer} from './server.js';

function main():void {
 const config=loadMcpConfig();const bridge=createBridgeTransport(config);
 const handle=serveStdio(()=>createLocalMcpServer(bridge),{legacy:'serve',maxSubscriptions:4,onerror:()=>{process.stderr.write('Workloom MCP protocol error.\n');}});
 let stopping:Promise<void>|undefined;
 const stop=()=>{stopping??=(async()=>{bridge.close();await handle.close();})();return stopping;};
 const safelyStop=()=>{void stop().catch(()=>{process.stderr.write('Workloom MCP could not close cleanly.\n');process.exitCode=1;});};
 process.once('SIGTERM',safelyStop);process.once('SIGINT',safelyStop);
 process.stdin.once('end',safelyStop);
}
try{main();}catch{process.stderr.write('Workloom MCP could not start. Check local configuration.\n');process.exitCode=1;}
