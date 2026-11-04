#!/usr/bin/env node
// Start, test and stop one isolated emulator in this same parent process.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {existsSync,createWriteStream,mkdirSync} from 'node:fs';
import net from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url));
const jar=process.env.SH_FIRESTORE_EMULATOR_JAR||resolve(root,'../tooling/r13-media/cloud-firestore-emulator-v1.19.8.jar');
if(!existsSync(jar))throw Error('The isolated Firestore emulator JAR is required.');
await new Promise((done,reject)=>{const probe=net.createServer();probe.once('error',reject);probe.listen(8089,'127.0.0.1',()=>probe.close(done));});
const output=process.env.SH_STORAGE_EMULATOR_OUTPUT||resolve(root,'../storage-migration-emulator-results');mkdirSync(output,{recursive:true});
const log=createWriteStream(resolve(output,'firestore-emulator.log'));
const emulator=spawn(process.env.SH_TEST_JAVA||'java',['-Xms64m','-Xmx512m','-jar',jar,'--host=127.0.0.1','--port=8089','--project_id=demo-sh-storage-migration'],
  {cwd:root,env:{PATH:process.env.PATH,JAVA_HOME:process.env.JAVA_HOME},stdio:['ignore','pipe','pipe']});
emulator.stdout.pipe(log,{end:false});emulator.stderr.pipe(log,{end:false});let run,launchError;
emulator.on('error',error=>{launchError=error;});
const stop=()=>{run?.kill('SIGTERM');emulator.kill('SIGTERM');};process.once('SIGINT',stop);process.once('SIGTERM',stop);
try{
  const deadline=Date.now()+60000;
  for(;;){if(launchError)throw launchError;if(emulator.exitCode!==null)throw Error('Isolated emulator exited before startup.');
    try{await fetch('http://127.0.0.1:8089',{signal:AbortSignal.timeout(1000)});break;}catch{}
    if(Date.now()>deadline)throw Error('Isolated emulator startup timed out.');await new Promise(done=>setTimeout(done,200));}
  run=spawn(process.execPath,['--test','tests/operator-storage-migration-emulator.test.mjs'],{cwd:root,stdio:'inherit',
    env:{...process.env,SH_STORAGE_MIGRATION_EMULATOR_TESTS:'1',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8089',METADATA_SERVER_DETECTION:'none'}});
  process.exitCode=await new Promise((done,reject)=>{run.once('error',reject);run.once('exit',code=>done(code??1));});
}finally{
  emulator.kill('SIGTERM');await new Promise(done=>{if(emulator.exitCode!==null)return done();const timer=setTimeout(()=>{emulator.kill('SIGKILL');done();},3000);
    emulator.once('exit',()=>{clearTimeout(timer);done();});});log.end();
}
