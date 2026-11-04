import test from 'node:test';
import assert from 'node:assert/strict';
import {registerOperatorAdminRoutes} from '../operator-admin.js';

function fixture({fail=false}={}) {
  const handlers=new Map(),actions=[];
  registerOperatorAdminRoutes({get:(path,fn)=>handlers.set('GET '+path,fn),post:(path,fn)=>handlers.set('POST '+path,fn)}, {
    firestoreRuntime:{configured:true,deviceRegistry:{}},mediaGateway:{},
    authorize:req=>req.sudo===true,
    env:{APP_URL:'https://operator.example.test',PROFILE_SESSION_SECRET:'s'.repeat(48),PROFILE_PASS_SUDO:'synthetic-only'},
    migrationAdministrationFactory:()=>({status:async()=>({configured:true}),close:async()=>{},
      run:action=>{actions.push(action);if(fail)throw Object.assign(Error('private source token must not appear'),{storageMigrationError:true,status:409});return {accepted:true};}})
  });
  return {actions,async request({method='POST',sudo=true,origin='https://operator.example.test',header='1',body={action:'copy'}}={}) {
    const response={statusCode:200,set(){return this;},status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};
    await handlers.get(method+' /api/operator-android/admin/storage-migration')({sudo,method,headers:{origin,'x-sh-admin-action':header},body},response);
    return response;
  }};
}
test('storage update actions require SUDO, exact origin and explicit admin header before invoking the manager',async()=>{
  const f=fixture();
  assert.equal((await f.request({sudo:false})).statusCode,401);
  assert.equal((await f.request({origin:'https://untrusted.example.test'})).statusCode,403);
  assert.equal((await f.request({header:''})).statusCode,403);
  assert.deepEqual(f.actions,[]);
  assert.equal((await f.request()).body.accepted,true);assert.deepEqual(f.actions,['copy']);
});
test('storage update status requires SUDO and manager failures never expose private errors',async()=>{
  const f=fixture({fail:true});
  assert.equal((await f.request({method:'GET',sudo:false})).statusCode,401);
  assert.equal((await f.request({method:'GET',origin:'',header:''})).body.configured,true);
  const result=await f.request();assert.equal(result.statusCode,409);
  assert.equal(result.body.ok,false);assert.ok(!JSON.stringify(result.body).includes('private source token'));
});
