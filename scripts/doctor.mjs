// No credentials, tokens or model content are printed.
import {setDefaultResultOrder} from 'node:dns';
setDefaultResultOrder('ipv4first');
const base=(process.argv[2]||'http://localhost:8080').replace(/\/$/,'');
let failed=false;
for(const [path,label,release] of [['/','frontend',false],['/health/service','API and database',false],['/help/safety','safety help',false],['/health/ready','public release policy',true]]) {
  try{const response=await fetch(base+path,{signal:AbortSignal.timeout(10000)});console.log(`${label}: ${response.status}${release&&response.status===503?' (draft catalog or release requirements pending)':''}`);if(!response.ok&&!release)failed=true;}catch{console.log(`${label}: connection failed`);failed=true;}
}
process.exitCode=failed?1:0;
