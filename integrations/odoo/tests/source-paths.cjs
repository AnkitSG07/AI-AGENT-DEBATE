const fs = require('node:fs');
const path = require('node:path');
// The standalone review bundle and the repository use different parent folders.
// Both layouts resolve the same shipped production files, never a copied fixture.
const candidate = path.resolve(__dirname, '../../backend');
const backendDir = process.env.SH_BACKEND_SOURCE || (fs.existsSync(path.join(candidate, 'server.js')) ? candidate : path.resolve(__dirname, '../../..'));
const androidDir = process.env.SH_ANDROID_SOURCE || (fs.existsSync(path.resolve(__dirname, '../../operator-android/app')) ? path.resolve(__dirname, '../../operator-android') : path.join(backendDir, 'android/operatorhub'));
module.exports = { backendDir, androidDir };
