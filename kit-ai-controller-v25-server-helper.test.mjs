import assert from 'node:assert/strict';
import {
  sanitizeKitPlan,
  legacyActionsToKitPlan,
  buildKitControllerPromptContext
} from './kit-ai-controller-v25-server-helper.js';

const kitContext = {
  kitBuilderSnapshot: {
    selectedApplicationId: 'rechargeable',
    selectedDriverId: '201-lc',
    currentStep: '3',
    currentPartsTab: 'led',
    selectedItemIds: ['201-lc-driver'],
    validation: { complete:false, progress:35, errors:[{id:'led',message:'Choose one compatible LED.'}] },
    controller: { actions:['select_application','select_driver','add_product','remove_product','go_to_step'] },
    availableNow: {
      drivers:[{id:'201-lc',code:'AS-B-201-LC',name:'201 LC',family:'rechargeable',maxWatt:3}],
      products:[{id:'2w-35mm',name:'2W 35mm COB',sku:'SH-COB-2W-35',category:'led',watt:2,selected:false}]
    },
    planningCatalog: {
      applications:[{id:'rechargeable',name:'Rechargeable',allowedDrivers:['201-lc'],recommendedDriver:'201-lc'}],
      drivers:[{id:'201-lc',code:'AS-B-201-LC',name:'201 LC'}],
      products:[{id:'2w-35mm',name:'2W 35mm COB',sku:'SH-COB-2W-35'}],
      templates:[{id:'tpl-201-lc-2w',name:'201 LC 2W Kit',appId:'rechargeable',driverId:'201-lc'}]
    }
  }
};

const plan = sanitizeKitPlan({
  mode:'auto_build',
  actions:[
    {type:'select_application',applicationId:'rechargeable'},
    {type:'select_driver',builder_driver_id:'201-lc'},
    {type:'add_product',builder_product_id:'2w-35mm',qty:1},
    {type:'go_to_step',step:4}
  ]
}, kitContext);
assert.equal(plan.actions[1].driverId, '201-lc');
assert.equal(plan.actions[2].productId, '2w-35mm');

const legacy = legacyActionsToKitPlan([
  {action:'add',builder_driver_id:'201-lc',qty:1},
  {action:'add',builder_product_id:'2w-35mm',qty:1}
], kitContext);
assert.deepEqual(legacy.actions.map(a=>a.type), ['select_driver','add_product']);

assert.throws(() => sanitizeKitPlan({actions:[{type:'add_product',productId:'invented-sku'}]}, kitContext), /Unknown product id/);
assert.throws(() => sanitizeKitPlan({actions:[{type:'select_driver',driverId:'999'}]}, kitContext), /Unknown driver id/);

const promptContext = buildKitControllerPromptContext(kitContext);
assert.equal(promptContext.selected_driver_id, '201-lc');
assert.equal(promptContext.available_now.products[0].id, '2w-35mm');

console.log('Kit AI Controller V25 helper tests passed.');
