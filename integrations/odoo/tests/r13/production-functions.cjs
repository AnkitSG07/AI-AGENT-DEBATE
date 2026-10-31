'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const sourcePath = process.env.SH_TEST_EMBED || path.resolve(__dirname, '../../smart-handicrafts-whatsapp-embed-r13.html');
const source = fs.readFileSync(sourcePath, 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp('^  (?:async )?function ' + name + '\\(', 'm'));
  if (start < 0) throw new Error('Production function missing: ' + name);
  const end = source.indexOf('\n  }', start);
  const text = source.slice(start, end + 4);
  new vm.Script(text, { filename: name });
  return text;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a,b) => { resolve=a; reject=b; });
  return {promise,resolve,reject};
}
function node(value='') {
  return {value,disabled:false,textContent:'',innerHTML:'',dataset:{},focus(){},setAttribute(){},
    classList:{add(){},remove(){},toggle(){},contains(){return false;}}};
}
function context(functions, values={}) {
  const c = { console:{log(){},warn(){},error(){}}, Date, Promise, Map, Set,
    setTimeout,clearTimeout,setInterval,clearInterval,URL,URLSearchParams,AbortController,DOMException,
    localStorage:{getItem(){return null;},setItem(){},removeItem(){}}, ...values };
  vm.createContext(c);
  vm.runInContext([...new Set(functions)].map(productionFunction).join('\n\n'),c);
  return c;
}
module.exports={context,deferred,node,productionFunction,source,sourcePath,
  sourceSHA256:crypto.createHash('sha256').update(source).digest('hex')};
