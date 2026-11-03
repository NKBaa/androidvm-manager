// Generates sdkmanager-compatible package.xml + source.properties for the fetched packages.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';

const sdkRoot = process.argv[2];
const REPO = 'https://dl.google.com/android/repository/';
const NS = 'xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns3="http://schemas.android.com/repository/android/common/01" xmlns:ns4="http://schemas.android.com/repository/android/generic/01" xmlns:ns5="http://schemas.android.com/repository/android/generic/02" xmlns:ns6="http://schemas.android.com/sdk/android/repo/addon2/01" xmlns:ns7="http://schemas.android.com/sdk/android/repo/addon2/02" xmlns:ns8="http://schemas.android.com/sdk/android/repo/addon2/03" xmlns:ns9="http://schemas.android.com/sdk/android/repo/repository2/01" xmlns:ns10="http://schemas.android.com/sdk/android/repo/repository2/02" xmlns:ns11="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:ns12="http://schemas.android.com/sdk/android/repo/sys-img2/04" xmlns:ns13="http://schemas.android.com/sdk/android/repo/sys-img2/03" xmlns:ns14="http://schemas.android.com/sdk/android/repo/sys-img2/02" xmlns:ns15="http://schemas.android.com/sdk/android/repo/sys-img2/01"';

function getText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const licText = fs.existsSync(path.join(sdkRoot, 'licenses', 'android-sdk-license'))
  ? fs.readFileSync(path.join(sdkRoot, 'licenses', 'android-sdk-license'), 'utf8').trim() : 'Terms and Conditions';

async function gen(base, pkgPath) {
  const xml = await getText(REPO + base + 'sys-img2-3.xml');
  const blocks = xml.split('<remotePackage ').slice(1);
  const bl = blocks.find(b => (b.match(/path="([^"]*)"/) || [])[1] === pkgPath);
  if (!bl) throw new Error('not found ' + pkgPath);
  const grab = (tag) => (bl.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')) || [])[1] || '';
  const api = grab('api-level'), ext = grab('extension-level'), abi = grab('abi');
  const tagId = (bl.match(/<tag>[\s\S]*?<id>([^<]*)<\/id>/) || [])[1];
  const tagDisp = (bl.match(/<tag>[\s\S]*?<display>([^<]*)<\/display>/) || [])[1];
  const vendId = (bl.match(/<vendor>[\s\S]*?<id>([^<]*)<\/id>/) || [])[1];
  const vendDisp = (bl.match(/<vendor>[\s\S]*?<display>([^<]*)<\/display>/) || [])[1];
  const rev = bl.match(/<revision>([\s\S]*?)<\/revision>/)[1];
  const revXml = ['major', 'minor', 'micro', 'preview'].map(t => { const v = (rev.match(new RegExp('<' + t + '>([^<]*)</' + t + '>')) || [])[1]; return v ? `<${t}>${v}</${t}>` : ''; }).join('');
  const disp = grab('display-name');
  const pkgXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:repository ${NS}>
    <license id="android-sdk-license" type="text">${licText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</license>
    <localPackage path="${pkgPath}" obsolete="false">
        <type-details xsi:type="ns12:sysImgDetailsType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
            <api-level>${api}</api-level>${ext ? `<extension-level>${ext}</extension-level><base-extension>true</base-extension>` : ''}
            <tag><id>${tagId}</id><display>${tagDisp}</display></tag>
            <vendor><id>${vendId}</id><display>${vendDisp}</display></vendor>
            <abi>${abi}</abi>
        </type-details>
        <revision>${revXml}</revision>
        <display-name>${disp}</display-name>
        <uses-license ref="android-sdk-license"/>
    </localPackage>
</ns2:repository>
`;
  const dir = path.join(sdkRoot, 'system-images', 'android-' + api, tagId, abi);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.xml'), pkgXml);
  const props = [
    'Pkg.Desc=System Image x86_64 with Google Play.',
    `Pkg.Revision=${(revXml.match(/<major>(\d+)<\/major>/) || [])[1] || rev}`,
    'Pkg.Dependencies=emulator#34.2.16',
    `AndroidVersion.ApiLevel=${api}`,
    `AndroidVersion.ExtensionLevel=${ext}`,
    'AndroidVersion.IsBaseSdk=true',
    `SystemImage.Abi=${abi}`,
    `SystemImage.TagId=${tagId}`,
    `SystemImage.TagDisplay=${tagDisp}`,
    'SystemImage.GpuSupport=true',
    `Addon.VendorId=${vendId}`,
    `Addon.VendorDisplay=${vendDisp}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'source.properties'), props);
  console.log('wrote metadata ->', dir);
}

async function genEmulator() {
  const xml = await getText(REPO + 'repository2-3.xml');
  const blocks = xml.split('<remotePackage ').slice(1);
  const bl = blocks.find(b => (b.match(/path="([^"]*)"/) || [])[1] === 'emulator');
  const rev = bl.match(/<revision>([\s\S]*?)<\/revision>/)[1];
  const major = (rev.match(/<major>(\d+)<\/major>/) || [])[1];
  const minor = (rev.match(/<minor>(\d+)<\/minor>/) || [])[1];
  const micro = (rev.match(/<micro>(\d+)<\/micro>/) || [])[1];
  const disp = (bl.match(/<display-name>([^<]*)<\/display-name>/) || [])[1] || 'Android Emulator';
  const xmlOut = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:repository ${NS}>
    <license id="android-sdk-license" type="text">${licText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</license>
    <localPackage path="emulator" obsolete="false">
        <type-details xsi:type="ns4:genericDetailsType" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
        <revision><major>${major}</major><minor>${minor}</minor><micro>${micro}</micro></revision>
        <display-name>${disp}</display-name>
        <uses-license ref="android-sdk-license"/>
    </localPackage>
</ns2:repository>
`;
  const dir = path.join(sdkRoot, 'emulator');
  fs.writeFileSync(path.join(dir, 'package.xml'), xmlOut);
  fs.writeFileSync(path.join(dir, 'source.properties'), `Pkg.Desc=${disp}\nPkg.Revision=${major}.${minor}.${micro}\n`);
  console.log('wrote emulator metadata ->', dir);
}

await gen('sys-img/google_apis_playstore/', 'system-images;android-34;google_apis_playstore;x86_64');
await gen('sys-img/google_atd/', 'system-images;android-34;google_atd;x86_64');
await genEmulator();

