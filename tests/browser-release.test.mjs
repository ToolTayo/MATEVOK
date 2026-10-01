import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dist = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const serviceWorkerSource = readFileSync(join(dist, "sw.js"), "utf8");
const shellVersion = serviceWorkerSource.match(/^const CACHE_NAME = "teacher-workspace-shell-v(\d+)";$/m)?.[1];
if (!shellVersion) throw new Error("The service worker must declare the current shell version.");
const currentCacheName = `teacher-workspace-shell-v${shellVersion}`;
const staleCacheNames = Array.from({ length: 6 }, (_, index) => `teacher-workspace-shell-v${Number(shellVersion) - 6 + index}`);
const chromePath = process.env.MATEVOK_CHROME_PATH || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
].find((path) => process.platform === "win32" && existsSync(path));

const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"], [".json", "application/json; charset=utf-8"]
]);

function headerRules(source) {
  const rules = [];
  let current = null;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) { current = { pattern: line.trim(), headers: {} }; rules.push(current); continue; }
    const match = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (match && current) current.headers[match[1].toLowerCase()] = match[2];
  }
  return rules;
}

function ruleMatches(pattern, pathname) {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(pathname);
}

async function listen(server) {
  await new Promise((resolveListen, reject) => server.listen(0, "127.0.0.1", resolveListen).once("error", reject));
  return server.address().port;
}

function cdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  const ready = new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params);
  });
  return {
    ready,
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolveCall, reject) => {
        pending.set(id, { resolve: resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) { const group = listeners.get(method) || []; group.push(listener); listeners.set(method, group); },
    close() { socket.close(); }
  };
}

const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

test(`production-like Chromium workflow, responsive layouts, ${currentCacheName} offline shell, and encrypted restore`, { skip: !chromePath && "No installed Chrome/Edge executable was found." }, async (t) => {
  const tempRoot = await mkdtemp(join(os.tmpdir(), "matevok-release-"));
  const profile = join(tempRoot, "profile");
  const downloads = join(tempRoot, "downloads");
  await mkdir(downloads);
  const headersText = await readFile(join(dist, "_headers"), "utf8");
  const rules = headerRules(headersText);
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const requestRecord = { path: url.pathname, method: request.method };
    requests.push(requestRecord);
    response.on("finish", () => { requestRecord.status = response.statusCode; });
    if (url.pathname === "/__release_test__") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end('<!doctype html><link rel="icon" href="/favicon.svg"><title>Release test</title>');
      return;
    }
    if (url.pathname === "/_headers") { response.writeHead(404).end(); return; }
    let target = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (target !== dist && !target.startsWith(`${dist}${sep}`)) { response.writeHead(403).end(); return; }
    if (target === dist || (await stat(target).catch(() => null))?.isDirectory()) target = join(dist, "index.html");
    const file = await readFile(target).catch(() => null);
    if (!file) {
      if ((request.headers.accept || "").includes("text/html")) {
        target = join(dist, "index.html");
      } else { response.writeHead(404).end("Not found"); return; }
    }
    const ext = extname(target);
    const outgoing = {
      "Content-Type": mime.get(ext) || "application/octet-stream",
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff"
    };
    for (const rule of rules) if (ruleMatches(rule.pattern, url.pathname)) {
      for (const [name, value] of Object.entries(rule.headers)) {
        for (const key of Object.keys(outgoing)) if (key.toLowerCase() === name) delete outgoing[key];
        outgoing[name] = value;
      }
    }
    const body = file || await readFile(target);
    response.writeHead(200, outgoing);
    if (request.method === "HEAD") response.end(); else response.end(body);
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const browserPortServer = createNetServer();
  const browserPort = await listen(browserPortServer);
  await new Promise((resolveClose) => browserPortServer.close(resolveClose));
  let chrome;
  let chromeExited;
  let browser;
  let page;
  let targetId;
  const consoleIssues = [];
  const pageRequests = [];
  const cdpHttp = `http://127.0.0.1:${browserPort}`;

  async function waitFor(expression, label, timeout = 12000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try { if (await evaluate(expression)) return; } catch {}
      await pause(80);
    }
    let pageState = "unavailable";
    try { pageState = JSON.stringify(await evaluate("(()=>({url:location.href,online:navigator.onLine,heading:document.querySelector('[data-app] h1')?.textContent,storage:document.querySelector('[data-storage-message]')?.textContent,activeNav:[...document.querySelectorAll('[data-nav-item][data-current]')].map(x=>x.dataset.navItem),targetNav:(()=>{const x=document.querySelector('[data-nav-item=Gradebook]');return x&&{disabled:x.disabled,current:x.hasAttribute('data-current'),sidebarOpen:document.querySelector('[data-sidebar]')?.dataset.open}})(),openDialogs:[...document.querySelectorAll('dialog[open]')].map(x=>({name:x.dataset.dialog,error:x.querySelector('[data-operation-error]')?.textContent,submitDisabled:x.querySelector('[type=submit]')?.disabled})),attendanceSave:[...document.querySelectorAll('[data-attendance-save-state]')].map(x=>x.textContent),leaveAttendanceOpen:document.querySelector('[data-dialog=leave-attendance]')?.open,body:document.querySelector('[data-app]')?.innerText?.slice(0,500)}))()")); } catch {}
    throw new Error(`Timed out waiting for ${label}; page=${pageState}`);
  }
  async function evaluate(expression) {
    const result = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async function setViewport(width, height) {
    await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 700 });
    await pause(60);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true, `page overflows at ${width}px`);
  }
  async function clickButton(text) {
    const result = await evaluate(`(()=>{const dialog=document.querySelector('dialog[open]'),scope=dialog||document,b=[...scope.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}||x.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw new Error('Missing button: '+${JSON.stringify(text)}+'; dialog='+(dialog?.dataset.dialog||'none')+'; app='+(document.querySelector('[data-app]')?.innerText||'').slice(0,600));b.click();return true})()`);
    assert.equal(result, true);
  }
  async function nav(label) {
    const selector = `[data-nav-item=${JSON.stringify(label)}]`;
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing navigation: '+${JSON.stringify(label)});e.click();return true})()`);
    await pause(120);
  }
  async function fill(selector, value) {
    return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing field: '+${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  }
  async function readStorage(expression) {
    return evaluate(`import('./storage.js').then(async s=>(${expression}))`);
  }

  try {
    chrome = spawn(chromePath, [
      "--headless=new", "--disable-gpu", "--disable-gpu-sandbox", "--disable-software-rasterizer",
      "--disable-gpu-compositing", "--use-gl=disabled", "--no-sandbox",
      "--disable-features=Vulkan,UseSkiaRenderer", "--disable-crash-reporter", "--disable-breakpad", "--disable-crashpad-for-testing",
      "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-extensions",
      "--remote-allow-origins=*", `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`, "about:blank"
    ], { stdio: "ignore", windowsHide: true });
    chromeExited = new Promise((resolveExit) => chrome.once("exit", (code, signal) => resolveExit({ code, signal })));
    chrome.unref();
    const debugDeadline = Date.now() + 15000;
    let browserInfo;
    while (Date.now() < debugDeadline) {
      try { browserInfo = await (await fetch(`${cdpHttp}/json/version`)).json(); break; } catch { await pause(100); }
    }
    assert.ok(browserInfo?.webSocketDebuggerUrl, "Chromium remote debugging endpoint did not start");
    browser = cdp(browserInfo.webSocketDebuggerUrl);
    await browser.ready;
    let targets = [];
    const targetsDeadline = Date.now() + 5000;
    while (Date.now() < targetsDeadline) {
      targets = await (await fetch(`${cdpHttp}/json/list`)).json();
      if (targets.some((target) => target.type === "page")) break;
      await pause(50);
    }
    const target = targets.find((item) => item.type === "page");
    assert.ok(target?.webSocketDebuggerUrl, "Chromium did not expose a page target");
    targetId = target.id;
    page = cdp(target.webSocketDebuggerUrl);
    await page.ready;
    page.on("Runtime.exceptionThrown", (event) => consoleIssues.push(event.exceptionDetails?.text || "uncaught exception"));
    page.on("Log.entryAdded", (event) => { if (["error", "warning"].includes(event.entry.level)) consoleIssues.push(`${event.entry.level}: ${event.entry.text}`); });
    page.on("Network.requestWillBeSent", (event) => pageRequests.push({ url: event.request.url, method: event.request.method }));
    await Promise.all([page.call("Page.enable"), page.call("Runtime.enable"), page.call("Log.enable"), page.call("Network.enable")]);
    await browser.call("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });

    const response = await fetch(origin);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
    assert.match(response.headers.get("permissions-policy"), /camera=\(\)/);
    const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(manifestResponse.headers.get("content-type"), "application/manifest+json; charset=utf-8");
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, "MATEVOK");
    assert.equal(manifest.short_name, "MATEVOK");
    assert.equal(manifest.start_url, "./");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.theme_color);
    assert.ok(manifest.background_color);
    assert.ok(manifest.icons.some((icon) => icon.sizes.includes("192x192")));
    assert.ok(manifest.icons.some((icon) => icon.sizes.includes("512x512")));
    const assetFiles = (await readdir(dist)).filter((name) => name !== "_headers");
    for (const asset of assetFiles) {
      const assetResponse = await fetch(`${origin}/${asset}`);
      assert.equal(assetResponse.status, 200, `${asset} did not load from the production-like host`);
      assert.equal(assetResponse.headers.get("content-type"), mime.get(extname(asset)) || "application/octet-stream", `${asset} used an unexpected MIME type`);
      await assetResponse.arrayBuffer();
    }
    const workerResponse = await fetch(`${origin}/sw.js?v=${shellVersion}`);
    assert.equal(workerResponse.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
    await workerResponse.arrayBuffer();

    await page.call("Page.navigate", { url: `${origin}/__release_test__` });
    await waitFor("document.readyState==='complete'", "test origin setup page");
    await evaluate(`Promise.all(${JSON.stringify(staleCacheNames)}.map(n=>caches.open(n).then(c=>c.put('/obsolete-shell-entry',new Response('stale')))))`);
    await page.call("Page.navigate", { url: `${origin}/` });
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "application storage startup");
    assert.ok(await evaluate("document.querySelector('#first-use-heading')?.textContent.includes('Set up once')"), "empty first-use state did not appear");
    await clickButton("Create your first class");
    await waitFor("document.querySelector('[data-dialog=class]')?.open", "class dialog");
    await fill('[data-dialog="class"] [name="className"]', "Synthetic Release QA");
    await fill('[data-dialog="class"] [name="gradeLevel"]', "Grade 7");
    await fill('[data-dialog="class"] [name="subject"]', "Science");
    await fill('[data-dialog="class"] [name="term"]', "2026–2027");
    await fill('[data-dialog="class"] [name="schedule"]', "Mon/Wed · 8:00 AM");
    await evaluate("document.querySelector('[data-dialog=class] form').requestSubmit()");
    await waitFor("document.querySelector('.roster-panel h2')?.textContent.includes('Students · 0')", "new class workspace");
    await clickButton("Paste roster");
    await waitFor("document.querySelector('[data-dialog=bulk]')?.open", "bulk roster dialog");
    const names = Array.from({ length: 40 }, (_, index) => `Synthetic Student ${String(index + 1).padStart(2, "0")}`);
    await fill('[data-dialog="bulk"] textarea[name="roster"]', names.join("\n"));
    await evaluate("document.querySelector('[data-dialog=bulk] form').requestSubmit()");
    await waitFor("document.querySelector('.roster-panel h2')?.textContent.includes('Students · 40')", "40-student roster save");

    const seed = await readStorage(`(async()=>{
      const main=(await s.listClasses()).find(c=>c.className==='Synthetic Release QA');
      const students=await s.listStudents(main.id);
      const second=await s.saveClass({className:'Synthetic Release QA Second',gradeLevel:'Grade 7',subject:'Mathematics',term:'2026–2027',schedule:'Tue/Thu · 9:00 AM'});
      const extraRoster=label=>Array.from({length:35},(_,index)=>({fullName:label+' '+String(index+1).padStart(2,'0')}));
      await s.saveStudents(extraRoster('Second-class Student'),second.id);
      const priorDate=new Date();priorDate.setDate(priorDate.getDate()-10);
      await s.saveLesson({title:'Synthetic Recently Edited Plan',date:s.getLocalDateString(priorDate),status:'draft',learningGoals:'Synthetic fallback goal'},second.id);
      for(let index=3;index<=8;index++){const section=await s.saveClass({className:'Synthetic Section '+String(index).padStart(2,'0'),gradeLevel:'Grade 7',subject:'English',term:'2026–2027',schedule:'Friday · 10:00 AM'});await s.saveStudents(extraRoster('Section '+String(index).padStart(2,'0')+' Student'),section.id);}
      const date=s.getLocalDateString();
      const assessment=await s.saveAssessment({title:'Synthetic Weekly Check',date,maximumScore:'10',instructions:'Synthetic browser verification'},main.id);
      const question=await s.saveAuthoredQuestion({questionType:'multiple-choice',prompt:'Synthetic question?',points:'2',options:[{text:'Choice A',correct:true},{text:'Choice B',correct:false}]},assessment.id);
      await s.saveScores(assessment.id,[{studentId:students[0].id,rawScore:'0'},{studentId:students[1].id,rawScore:'8.5'}]);
      const history=[];
      for(let index=0;index<19;index++){
        const date='2025-'+String(Math.floor(index/12)+1).padStart(2,'0')+'-'+String((index%28)+1).padStart(2,'0');
        const older=await s.saveAssessment({title:'Synthetic Term Review '+String(index+1).padStart(2,'0'),date,maximumScore:'20',category:'Review',term:'2025–2026'},main.id);
        history.push(older);
        if(index===0) await s.saveScores(older.id,students.map((student,studentIndex)=>({studentId:student.id,rawScore:String(studentIndex%21)})));
        else if(index===1) await s.saveScores(older.id,[{studentId:students[0].id,rawScore:'0'},{studentId:students[1].id,rawScore:'12.5'}]);
      }
      await s.saveAttendance(main.id,date,students.map((student,index)=>({studentId:student.id,status:index===0?'absent':index===1?'late':'present'})));
      const lesson=await s.saveLesson({title:'Synthetic Lesson Plan',date,status:'ready',learningGoals:'Synthetic learning goal',priorKnowledge:'Previously read chapter 2',materials:'Board and notebooks',before:'Recall yesterday’s question',during:'Compare two examples',checkForUnderstanding:'Ask for one reason',assessment:'Exit response'},main.id);
      await new Promise(resolve=>setTimeout(resolve,5));
      const nextDay=new Date();nextDay.setDate(nextDay.getDate()+1);
      const newerLesson=await s.saveLesson({title:'Synthetic Later Plan',date:s.getLocalDateString(nextDay),status:'draft',learningGoals:'Synthetic future learning goal'},main.id);
      await s.saveLessonToMaterials(lesson.id); await s.saveAssessmentToMaterials(assessment.id);
      const archived=await s.saveStudent({fullName:'Synthetic Archived Student'},main.id); await s.saveScores(assessment.id,[{studentId:archived.id,rawScore:'5'}]); await s.setStudentArchived(archived.id,true);
      return {classId:main.id,secondId:second.id,students:students.map(x=>({id:x.id,name:x.fullName})),assessmentId:assessment.id,historyAssessmentIds:history.map(x=>x.id),lessonId:lesson.id,newerLessonId:newerLesson.id,questionId:question.id,archivedId:archived.id,date};
    })()`);
    assert.equal(seed.students.length, 40);
    await page.call("Page.reload");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "reload with synthetic data");
    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('Synthetic class missing after reload');card.querySelector('button').click();return true})()`);
    await waitFor("document.querySelector('.today-workspace')", "Today Overview");
    assert.match(await evaluate("document.querySelector('.today-workspace').innerText"), /2 of 40 active scores entered/);
    assert.match(await evaluate("document.querySelector('.today-workspace').innerText"), /Present 38 · Absent 1 · Late 1 · Excused 0/);
    assert.equal(await evaluate("document.querySelector('.today-card--lesson h3')?.textContent"), "Synthetic Lesson Plan", "Today must prefer the lesson dated today over the more recently edited future lesson");
    assert.match(await evaluate("document.querySelector('.today-card--lesson').innerText"), /Ready · Planned for today/);

    await nav("Class Work");
    await clickButton("Add class work");
    await waitFor("document.querySelector('[data-dialog=class-work]')?.open", "new class-work dialog");
    await fill('[data-dialog="class-work"] input[name="title"]', "Synthetic Chapter 3 Worksheet");
    await fill('[data-dialog="class-work"] input[name="dueDate"]', seed.date);
    await evaluate(`(()=>{const select=document.querySelector('[data-dialog="class-work"] select[name="assessmentId"]');select.value=${JSON.stringify(seed.assessmentId)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await evaluate("document.querySelector('[data-dialog=class-work] form').requestSubmit()");
    await waitFor("document.querySelectorAll('[data-work-status]').length===40", "40-student Class Work submission entry");
    const classWorkItemId = await readStorage(`s.listClassWork(${JSON.stringify(seed.classId)}).then(items=>items.find(item=>item.title==='Synthetic Chapter 3 Worksheet')?.id)`);
    assert.ok(classWorkItemId, "Class Work was not persisted in its class");
    await evaluate(`(()=>{const statuses=new Map([[${JSON.stringify(seed.students[0].id)},'submitted'],[${JSON.stringify(seed.students[1].id)},'missing'],[${JSON.stringify(seed.students[2].id)},'excused'],[${JSON.stringify(seed.students[3].id)},'submitted']]);for(const [studentId,status] of statuses){const select=document.querySelector('[data-work-status="'+studentId+'"]');select.value=status;select.dispatchEvent(new Event('change',{bubbles:true}))}})()`);
    assert.equal(await evaluate("document.querySelector('[data-class-work-save-state]')?.textContent"), "Unsaved changes");
    await evaluate("(()=>{const row=[...document.querySelectorAll('[data-class-work-student]')].find(x=>x.innerText.includes('Synthetic Student 05'));const select=row.querySelector('select');select.value='submitted';select.dispatchEvent(new Event('change',{bubbles:true}))})()");
    assert.match(await evaluate("document.querySelector('[data-class-work-counts]')?.textContent"), /Submitted 3.*Missing 1.*Excused 1.*Not recorded 35/);
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      const metrics = await evaluate("(()=>({overflow:document.documentElement.scrollWidth>innerWidth,controls:[...document.querySelectorAll('[data-work-status]')].slice(0,3).map(x=>x.getBoundingClientRect().height),save:[...document.querySelectorAll('[data-class-work-save]')].map(x=>({height:x.getBoundingClientRect().height,display:getComputedStyle(x).display}))}))()");
      assert.equal(metrics.overflow, false, `Class Work overflows at ${width}px`);
      if (width <= 700) assert.ok(metrics.controls.every((height) => height >= 44), `Class Work status controls are too small at ${width}px`);
      if (width === 390) assert.ok(metrics.save.some((item) => item.display !== "none" && item.height >= 44), "Class Work sticky save action is missing on mobile");
    }
    await setViewport(390, 844);
    const classWorkSticky = await evaluate("(()=>{window.scrollTo(0,document.body.scrollHeight);const rows=[...document.querySelectorAll('[data-class-work-student]')],last=rows.at(-1),save=document.querySelector('.class-work-save--mobile'),r=last.getBoundingClientRect(),s=save.getBoundingClientRect();return {rows:rows.length,display:getComputedStyle(save).display,height:save.getBoundingClientRect().height,overlap:r.bottom>s.top&&r.top<s.bottom}})()");
    assert.equal(classWorkSticky.rows, 40);
    assert.notEqual(classWorkSticky.display, "none");
    assert.ok(classWorkSticky.height >= 44, "mobile Class Work Save target is under 44px");
    assert.equal(classWorkSticky.overlap, false, "sticky Class Work Save covers the final student row");
    await nav("Gradebook");
    await waitFor("document.querySelector('[data-dialog=leave-class-work]')?.open", "unsaved Class Work navigation guard");
    await clickButton("Keep editing");
    assert.equal(await evaluate("document.querySelector('[data-class-work-save-state]')?.textContent"), "Unsaved changes", "Keep editing must preserve the submission draft");

    await evaluate(`(()=>{const original=IDBObjectStore.prototype.put;let writes=0;window.__originalWorkStorePut=original;IDBObjectStore.prototype.put=function(value,...args){if(this.name==='workSubmissions'&&value?.workItemId===${JSON.stringify(classWorkItemId)}&&++writes===2)throw new DOMException('Synthetic storage write failure','QuotaExceededError');return original.call(this,value,...args)};return true})()`);
    await evaluate("document.querySelector('.class-work-save--mobile button[data-class-work-save]')?.click()");
    await waitFor("document.querySelector('[data-operation-error]')?.textContent.includes('classroom information was not changed')", "Class Work write failure feedback");
    const partialFailure = await readStorage(`s.listWorkSubmissionsForItem(${JSON.stringify(classWorkItemId)})`);
    assert.deepEqual(partialFailure, [], "a synchronous mid-batch write failure must roll back every status");
    assert.equal(await evaluate("document.querySelector('[data-class-work-save-state]')?.textContent"), "Unsaved changes", "failed persistence must not claim Saved");
    await evaluate("IDBObjectStore.prototype.put=window.__originalWorkStorePut;delete window.__originalWorkStorePut;true");

    await evaluate(`(()=>{window.__classWorkWriteBlockStarted=false;window.__classWorkWriteBlockDone=false;const open=indexedDB.open('teacher-workspace');open.onsuccess=()=>{const db=open.result,tx=db.transaction(['workSubmissions'],'readwrite'),store=tx.objectStore('workSubmissions'),blocker={id:'synthetic-work-write-blocker',classId:'synthetic-block',workItemId:'synthetic-block',studentId:'synthetic-block',status:'submitted',type:'work-submission',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};for(let i=0;i<12000;i++)store.put({...blocker,updatedAt:String(i)});store.delete(blocker.id);tx.oncomplete=()=>{window.__classWorkWriteBlockDone=true;db.close()};window.__classWorkWriteBlockStarted=true};return true})()`);
    await waitFor("window.__classWorkWriteBlockStarted", "synthetic IndexedDB write lock");
    const savingState = await evaluate(`(()=>{document.querySelector('.class-work-save--mobile button[data-class-work-save]')?.click();const select=document.querySelector('[data-work-status=${JSON.stringify(seed.students[4].id)}]'),before=select.value;select.value='missing';select.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-nav-item="Gradebook"]')?.click();return {saveState:document.querySelector('[data-class-work-save-state]')?.textContent,saveDisabled:document.querySelector('[data-class-work-save]')?.disabled,studentDisabled:select.disabled,statusAfterAttempt:select.value,activeNav:document.querySelector('[data-nav-item][data-current]')?.dataset.navItem,leaveDialog:document.querySelector('[data-dialog="leave-class-work"]')?.open,before}})()`);
    assert.equal(savingState.saveState, "Saving submission statuses…", "the in-flight write must be visible");
    assert.equal(savingState.saveDisabled, true, "double submission must be disabled while a write is pending");
    assert.equal(savingState.studentDisabled, true, "student controls must not mutate the submitted snapshot");
    assert.equal(savingState.statusAfterAttempt, savingState.before, "an attempted edit cannot alter an in-flight save snapshot");
    assert.equal(savingState.activeNav, "Class Work", "navigation must stay in the item until its save completes");
    assert.equal(savingState.leaveDialog, false, "the user should not be offered a misleading discard action during a pending write");
    await waitFor("window.__classWorkWriteBlockDone&&document.querySelector('[data-class-work-save-state]')?.textContent==='Saved on this device'", "Class Work save after queued storage transaction", 15000);
    await evaluate("document.querySelector('.class-work-save--mobile button[data-class-work-save]')?.click()");
    await waitFor("document.querySelector('[data-class-work-save-state]')?.textContent==='Saved on this device'", "explicit Class Work status save");
    const savedWorkStates = await readStorage(`s.listWorkSubmissionsForItem(${JSON.stringify(classWorkItemId)}).then(items=>items.map(({studentId,status})=>({studentId,status})))`);
    assert.equal(savedWorkStates.length, 5, "only explicitly recorded statuses should be persisted");
    assert.equal(savedWorkStates.find((entry) => entry.studentId === seed.students[0].id)?.status, "submitted", "a saved zero score must remain independently submitted");
    assert.equal(savedWorkStates.find((entry) => entry.studentId === seed.students[1].id)?.status, "missing", "a raw score does not infer that work was submitted");
    assert.equal(savedWorkStates.find((entry) => entry.studentId === seed.students[3].id)?.status, "submitted", "submitted-but-ungraded work remains representable");
    assert.equal(savedWorkStates.find((entry) => entry.studentId === seed.students[4].id)?.status, "submitted", "a submitted student with no score remains representable");

    await clickButton("Delete work");
    await waitFor("document.querySelector('[data-dialog=delete-class-work]')?.open", "Class Work delete confirmation");
    await fill('[data-dialog="delete-class-work"] input[name="confirmName"]', "not the title");
    await evaluate("document.querySelector('[data-dialog=delete-class-work] form').requestSubmit()");
    await waitFor("document.querySelector('[data-dialog=delete-class-work] [data-operation-error]')?.textContent.includes('Type the class-work title exactly')", "Class Work deletion mismatch protection");
    assert.equal(await readStorage(`s.getRecord('classWork',${JSON.stringify(classWorkItemId)}).then(Boolean)`), true);
    assert.equal((await readStorage(`s.listWorkSubmissionsForItem(${JSON.stringify(classWorkItemId)})`)).length, 5);
    await clickButton("Cancel");

    await clickButton("Delete work");
    await fill('[data-dialog="delete-class-work"] input[name="confirmName"]', "Synthetic Chapter 3 Worksheet");
    await evaluate(`(()=>{const original=IDBObjectStore.prototype.delete;let deletes=0;window.__originalWorkStoreDelete=original;IDBObjectStore.prototype.delete=function(...args){if(this.name==='workSubmissions'&&++deletes===2)throw new DOMException('Synthetic delete failure','QuotaExceededError');return original.apply(this,args)};return true})()`);
    await evaluate("document.querySelector('[data-dialog=delete-class-work] form').requestSubmit()");
    await waitFor("document.querySelector('[data-dialog=delete-class-work] [data-operation-error]')?.textContent.includes('classroom information was not changed')", "atomic Class Work deletion failure");
    assert.equal(await readStorage(`s.getRecord('classWork',${JSON.stringify(classWorkItemId)}).then(Boolean)`), true, "failed deletion must retain the work item");
    assert.equal((await readStorage(`s.listWorkSubmissionsForItem(${JSON.stringify(classWorkItemId)})`)).length, 5, "failed deletion must retain every saved status");
    await evaluate("IDBObjectStore.prototype.delete=window.__originalWorkStoreDelete;delete window.__originalWorkStoreDelete;true");
    await clickButton("Cancel");

    await nav("Overview");
    const dueWorkToday = await evaluate("document.querySelector('.today-card--class-work')?.innerText||''");
    assert.match(dueWorkToday, /Synthetic Chapter 3 Worksheet/);
    assert.match(dueWorkToday, /For this item: 3 submitted · 1 marked Missing · 1 excused · 35 not recorded/);
    await clickButton("Review submissions");
    await waitFor("document.querySelectorAll('[data-work-status]').length===40", "Today direct Class Work review");
    assert.equal(await evaluate("document.querySelector('[data-class-work-save-state]')?.textContent"), "Saved on this device");
    await nav("Overview");

    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      await nav("My Classes");
      if (width <= 700) {
        await clickButton("Open navigation");
        assert.equal(await evaluate("document.querySelector('[data-sidebar]').dataset.open==='true'"), true);
        assert.equal(await evaluate("document.querySelector('[data-sidebar]').getBoundingClientRect().right <= innerWidth"), true);
        await evaluate("document.querySelector('[data-sidebar-scrim]').click()");
        assert.equal(await evaluate("document.querySelector('[data-sidebar]').dataset.open==='false'"), true);
      }
      await clickButton("Backup & restore");
      const dialog = await evaluate("(()=>{const r=document.querySelector('[data-dialog=backup]').getBoundingClientRect();return {open:document.querySelector('[data-dialog=backup]').open,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()");
      assert.equal(dialog.open, true);
      assert.ok(dialog.left >= 0 && dialog.top >= 0 && dialog.right <= dialog.width && dialog.bottom <= dialog.height, `backup dialog clipped at ${width}px`);
      await evaluate("document.querySelector('[data-close-dialog=backup]').click()");
    }

    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('main class missing after responsive checks');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('.today-workspace')", "main class after responsive checks");
    await setViewport(390, 844);
    const rosterSearchState = await evaluate(`(()=>{const input=document.querySelector('[data-roster-search]');if(!input)throw new Error('long-roster student lookup missing');input.focus();input.value='sYnThetic student 39';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));return {focused:document.activeElement===input,caret:input.selectionStart,rows:document.querySelectorAll('[data-roster-results] .roster-list li').length,name:document.querySelector('[data-roster-results] .roster-list li strong')?.textContent,count:document.querySelector('[data-roster-result-count]')?.textContent}})()`);
    assert.equal(rosterSearchState.focused, true, "roster lookup must preserve keyboard focus while results update");
    assert.equal(rosterSearchState.caret, "sYnThetic student 39".length, "roster lookup must preserve the caret");
    assert.equal(rosterSearchState.rows, 1);
    assert.equal(rosterSearchState.name, "Synthetic Student 39");
    assert.equal(rosterSearchState.count, "1 of 40 active students");
    await clickButton("Edit");
    await waitFor("document.querySelector('[data-dialog=student]')?.open", "edit student from filtered roster");
    await fill('[data-dialog="student"] input[name="fullName"]', "Synthetic Student 39 — corrected");
    await evaluate("document.querySelector('[data-dialog=student] form').requestSubmit()");
    await waitFor("document.querySelector('[data-roster-results] li strong')?.textContent==='Synthetic Student 39 — corrected'", "corrected student return to filtered roster");
    assert.equal(await evaluate("document.activeElement===document.querySelector('[data-roster-search]')"), true, "saving a roster correction should return focus to name lookup");
    assert.equal(await evaluate("document.querySelector('[data-roster-result-count]')?.textContent"), "1 of 40 active students");
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      const searchBounds = await evaluate("(()=>{const r=document.querySelector('[data-roster-search]').getBoundingClientRect();return {width:r.width,height:r.height}})()");
      assert.ok(searchBounds.width > 0, `roster lookup is not visible at ${width}px`);
      if (width <= 700) assert.ok(searchBounds.height >= 44, `roster lookup target is too small at ${width}px`);
    }
    await setViewport(390, 844);
    const noRosterMatch = await evaluate(`(()=>{const input=document.querySelector('[data-roster-search]');input.value='No Such Learner';input.dispatchEvent(new Event('input',{bubbles:true}));return {focused:document.activeElement===input,rows:document.querySelectorAll('[data-roster-results] .roster-list li').length,message:document.querySelector('[data-roster-result-count]')?.textContent,empty:document.querySelector('[data-roster-results]')?.textContent}})()`);
    assert.equal(noRosterMatch.focused, true);
    assert.equal(noRosterMatch.rows, 0);
    assert.equal(noRosterMatch.message, "0 of 40 active students");
    assert.match(noRosterMatch.empty, /No active students match/);
    await evaluate(`(()=>{const input=document.querySelector('[data-roster-search]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate("document.querySelectorAll('[data-roster-results] .roster-list li').length"), 40, "clearing lookup restores the complete active roster");
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, "roster lookup overflows the phone viewport");
    await nav("Attendance");
    await waitFor("document.querySelectorAll('[data-attendance-row]').length===40", "40-row attendance workspace");
    const attendanceLookup = await evaluate(`(()=>{const input=document.querySelector('[data-attendance-search]');if(!input)throw new Error('long-roster attendance lookup missing');input.focus();input.value='synthetic student 39';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const row=document.querySelector('[data-attendance-row]');return {focused:document.activeElement===input,caret:input.selectionStart,rows:document.querySelectorAll('[data-attendance-row]').length,name:row?.querySelector('strong')?.textContent,count:document.querySelector('[data-attendance-search-count]')?.textContent,height:input.getBoundingClientRect().height}})()`);
    assert.equal(attendanceLookup.focused, true, "attendance lookup must preserve input focus while filtering");
    assert.equal(attendanceLookup.caret, "synthetic student 39".length);
    assert.equal(attendanceLookup.rows, 1);
    assert.equal(attendanceLookup.name, "Synthetic Student 39 — corrected");
    assert.match(attendanceLookup.count, /1 of 40 active students/);
    assert.match(attendanceLookup.count, /Mark all present applies to everyone/);
    assert.ok(attendanceLookup.height >= 44, "attendance lookup target is too small on mobile");
    await clickButton("Mark all present");
    assert.equal(await evaluate("document.querySelector('[data-attendance-row] [data-attendance-status=present]')?.getAttribute('aria-checked')"), "true");
    await clickButton("Save attendance");
    await waitFor("document.querySelector('[data-attendance-save-state]')?.textContent==='Saved on this device'", "whole-roster mark-present save");
    const allPresentAfterFilteredAction = await readStorage(`s.listAttendanceForDate(${JSON.stringify(seed.classId)},${JSON.stringify(seed.date)}).then(rows=>rows.every(row=>row.status==='present'))`);
    assert.equal(allPresentAfterFilteredAction, true, "Mark all present must still cover hidden rows while search is active");
    await evaluate(`(()=>{const input=document.querySelector('[data-attendance-search]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));const rows=[...document.querySelectorAll('[data-attendance-row]')];rows[0].querySelector('[data-attendance-status=absent]').click();rows[1].querySelector('[data-attendance-status=late]').click()})()`);
    assert.equal(await evaluate("document.querySelectorAll('[data-attendance-row]').length"), 40, "clearing the attendance lookup restores the full roster");
    const attendanceMetrics = await evaluate(`(()=>{window.scrollTo(0,document.body.scrollHeight);const rows=[...document.querySelectorAll('[data-attendance-row]')],last=rows.at(-1),save=document.querySelector('.attendance-save--mobile'),r=last.getBoundingClientRect(),s=save.getBoundingClientRect();return {rows:rows.length,saveVisible:getComputedStyle(save).display!=='none',lastBottom:r.bottom,saveTop:s.top,overlap:r.bottom>s.top&&r.top<s.bottom}})()`);
    assert.equal(attendanceMetrics.rows, 40);
    assert.equal(attendanceMetrics.saveVisible, true);
    assert.equal(attendanceMetrics.overlap, false, "sticky mobile Save covers the final student row");
    const thirdId = seed.students[2].id;
    const focusStayed = await evaluate(`(()=>{const row=document.querySelector('[data-attendance-row=${JSON.stringify(thirdId)}]'),button=row.querySelector('[data-attendance-status=absent]');button.focus();button.click();return row===document.querySelector('[data-attendance-row=${JSON.stringify(thirdId)}]')&&document.activeElement===button})()`);
    assert.equal(focusStayed, true, "attendance change rebuilt its row or lost focus");
    await evaluate("document.querySelectorAll('[data-attendance-save-state]')[0].closest('.attendance-save').querySelector('button').click();document.querySelectorAll('[data-attendance-save-state]')[1]?.closest('.attendance-save').querySelector('button').click()");
    await waitFor("[...document.querySelectorAll('[data-attendance-save-state]')].some(x=>x.textContent.includes('Saved on this device'))", "explicit attendance save");
    const attendanceAfterDoubleSubmit = await readStorage(`s.listAttendanceForDate(${JSON.stringify(seed.classId)},${JSON.stringify(seed.date)}).then(rows=>({count:rows.length,status:rows.find(x=>x.studentId===${JSON.stringify(thirdId)})?.status}))`);
    assert.equal(attendanceAfterDoubleSubmit.count, 40);
    assert.equal(attendanceAfterDoubleSubmit.status, "absent");

    await evaluate(`(()=>{const row=document.querySelector('[data-attendance-row=${JSON.stringify(seed.students[3].id)}]');row.querySelector('[data-attendance-status=late]').click()})()`);
    await waitFor("document.querySelector('[data-attendance-save-state]')?.textContent==='Unsaved changes'", "attendance edit state before navigation guard");
    await nav("Gradebook");
    assert.equal(await evaluate("document.querySelector('[data-dialog=leave-attendance]')?.open"), true, "unsaved attendance navigation was not guarded");
    await clickButton("Keep editing");
    assert.equal(await evaluate("document.querySelector('[data-attendance-save-state]')?.textContent"), "Unsaved changes");
    await clickButton("Save attendance");
    await waitFor("document.querySelector('[data-attendance-save-state]')?.textContent==='Saved on this device'", "second attendance save");
    await nav("Gradebook");
    await waitFor("document.querySelectorAll('.assessment-card').length===20", "20-assessment Gradebook");
    const assessmentLookup = await evaluate(`(()=>{const input=document.querySelector('[data-gradebook-search]'),filter=document.querySelector('[data-gradebook-score-filter]');if(!input||!filter)throw new Error('long Gradebook assessment controls missing');input.focus();input.value='Synthetic Term Review 19';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const found=document.querySelectorAll('.assessment-card').length,focused=document.activeElement===input,caret=input.selectionStart;filter.value='complete';filter.dispatchEvent(new Event('change',{bubbles:true}));const complete=document.querySelectorAll('.assessment-card').length;filter.value='needs';filter.dispatchEvent(new Event('change',{bubbles:true}));const incomplete=document.querySelectorAll('.assessment-card').length;input.value='Synthetic Term Review 01';input.dispatchEvent(new Event('input',{bubbles:true}));filter.value='complete';filter.dispatchEvent(new Event('change',{bubbles:true}));const completedAssessment=document.querySelectorAll('.assessment-card').length;filter.value='needs';filter.dispatchEvent(new Event('change',{bubbles:true}));const completedNeeds=document.querySelectorAll('.assessment-card').length;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));filter.value='all';filter.dispatchEvent(new Event('change',{bubbles:true}));const weekly=[...document.querySelectorAll('.assessment-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Weekly Check');return {found,focused,caret,complete,incomplete,completedAssessment,completedNeeds,total:document.querySelectorAll('.assessment-card').length,weekly:weekly?.innerText,count:document.querySelector('[data-gradebook-assessment-count]')?.textContent,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    assert.equal(assessmentLookup.found, 1, "assessment title lookup should narrow a 20-assessment list to one card");
    assert.equal(assessmentLookup.focused, true, "assessment lookup should keep focus while filtering");
    assert.equal(assessmentLookup.caret, "Synthetic Term Review 19".length);
    assert.equal(assessmentLookup.complete, 0, "completed assessments must not appear in the selected incomplete record");
    assert.equal(assessmentLookup.incomplete, 1);
    assert.equal(assessmentLookup.completedAssessment, 1, "fully entered active assessments must be available in the complete filter");
    assert.equal(assessmentLookup.completedNeeds, 0, "fully entered active assessments must not appear in Needs scores");
    assert.equal(assessmentLookup.total, 20);
    assert.match(assessmentLookup.weekly, /2 of 40 active scores entered/);
    assert.match(assessmentLookup.count, /20 of 20 assessments shown/);
    assert.equal(assessmentLookup.overflow, false, "Gradebook tools overflowed the phone viewport");
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      const metrics = await evaluate("(()=>({overflow:document.documentElement.scrollWidth>innerWidth,search:document.querySelector('[data-gradebook-search]')?.getBoundingClientRect().height,filter:document.querySelector('[data-gradebook-score-filter]')?.getBoundingClientRect().height}))()");
      assert.equal(metrics.overflow, false, `Gradebook assessment filters overflow at ${width}px`);
      if (width <= 700) assert.ok(metrics.search >= 44 && metrics.filter >= 44, `Gradebook assessment filter targets are too small at ${width}px`);
    }
    await setViewport(390, 844);
    await clickButton("Open scores");
    await waitFor("document.querySelectorAll('[data-score-input]').length===40", "score entry for 40 students");
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      const metrics = await evaluate("(()=>({overflow:document.documentElement.scrollWidth>innerWidth,search:document.querySelector('[data-score-search]')?.getBoundingClientRect().height,filter:document.querySelector('[data-score-filter]')?.getBoundingClientRect().height}))()");
      assert.equal(metrics.overflow, false, `Gradebook score controls overflow at ${width}px`);
      if (width <= 700) assert.ok(metrics.search >= 44 && metrics.filter >= 44, `Gradebook score controls are too small at ${width}px`);
    }
    await setViewport(390, 844);
    await fill(`[data-score-input=${JSON.stringify(seed.students[0].id)}]`, "0");
    await evaluate(`document.querySelector('[data-score-input=${JSON.stringify(seed.students[0].id)}]').focus()`);
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(`document.activeElement?.getAttribute('data-score-input')===${JSON.stringify(seed.students[1].id)}`), true, "Enter did not advance to the next roster score");
    await clickButton("Save scores");
    await waitFor("document.querySelector('[data-score-save-state]')?.textContent==='Saved on this device'", "score save");
    await fill(`[data-score-input=${JSON.stringify(seed.students[0].id)}]`, "1");
    await nav("Attendance");
    await waitFor("document.querySelector('[data-dialog=leave-scores]')?.open", "unsaved Gradebook navigation guard");
    await clickButton("Keep editing");
    assert.equal(await evaluate("document.querySelector('[data-dialog=leave-scores]')?.open"), false, "Keep editing should close the unsaved-score guard");
    assert.equal(await evaluate(`document.querySelector('[data-score-input=${JSON.stringify(seed.students[0].id)}]')?.value`), "1");
    await clickButton("Save scores");
    await waitFor("document.querySelector('[data-score-save-state]')?.textContent==='Saved on this device'", "guarded score save");
    await clickButton("Paste scores");
    const pasted = ["0", "8.5", "6", ...Array(37).fill("")].join("\n");
    await fill('[data-dialog="score-paste"] textarea[name="scores"]', pasted);
    await waitFor("document.querySelectorAll('[data-score-paste-review] li').length===40", "40-row score paste review");
    assert.match(await evaluate("document.querySelector('[data-score-paste-summary]').textContent"), /Save Scores is still required/);
    await fill('[data-dialog="score-paste"] input[name="confirmPaste"]', "");
    await evaluate("document.querySelector('[data-dialog=score-paste] input[name=confirmPaste]').checked=true;document.querySelector('[data-dialog=score-paste] input[name=confirmPaste]').dispatchEvent(new Event('change',{bubbles:true}))");
    await clickButton("Apply to score draft");
    await clickButton("Save scores");
    await waitFor("document.querySelector('[data-score-save-state]')?.textContent==='Saved on this device'", "pasted score explicit save");
    await pause(80);
    const scoreFind = await evaluate(`(()=>{const filter=document.querySelector('[data-score-filter]'),search=document.querySelector('[data-score-search]');if(!filter||!search)throw new Error('long-roster score search missing');filter.value='missing';filter.dispatchEvent(new Event('change',{bubbles:true}));const missing=document.querySelectorAll('[data-score-input]').length;filter.value='recorded';filter.dispatchEvent(new Event('change',{bubbles:true}));const recorded=document.querySelectorAll('[data-score-input]').length,zero=document.querySelector('[data-score-input=${JSON.stringify(seed.students[0].id)}]')?.value;filter.value='missing';filter.dispatchEvent(new Event('change',{bubbles:true}));search.focus();search.value='Synthetic Student 04';search.setSelectionRange(search.value.length,search.value.length);search.dispatchEvent(new Event('input',{bubbles:true}));const input=document.querySelector('[data-score-input]');return {missing,recorded,zero,visible:document.querySelectorAll('[data-score-input]').length,student:input?.getAttribute('aria-label'),blank:input?.value,focused:document.activeElement===search,activeTag:document.activeElement?.outerHTML.slice(0,160),searchConnected:search.isConnected,openDialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.dataset.dialog),caret:search.selectionStart,dirty:document.querySelector('[data-score-save-state]')?.textContent,summary:document.querySelector('[data-score-entry-count]')?.textContent}})()`);
    assert.equal(scoreFind.missing, 37, "saved score filtering must classify blank records as missing");
    assert.equal(scoreFind.recorded, 3);
    assert.equal(scoreFind.zero, "0", "a saved zero must remain a recorded score");
    assert.equal(scoreFind.visible, 1);
    assert.match(scoreFind.student, /Synthetic Student 04 score/);
    assert.equal(scoreFind.blank, "", "a missing score must remain blank rather than zero");
    assert.equal(scoreFind.focused, true, `student search must retain focus (${scoreFind.activeTag}; connected=${scoreFind.searchConnected}; open=${scoreFind.openDialogs.join(",")})`);
    assert.equal(scoreFind.caret, "Synthetic Student 04".length);
    assert.match(scoreFind.dirty, /Saved on this device/);
    await fill('[data-score-input=' + JSON.stringify(seed.students[3].id) + ']', "0");
    await clickButton("Save scores");
    await waitFor("document.querySelector('[data-score-save-state]')?.textContent==='Saved on this device'", "zero-score correction save");
    await evaluate(`(()=>{const search=document.querySelector('[data-score-search]');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    assert.equal(await evaluate("document.querySelectorAll('[data-score-input]').length"), 36, "a saved zero moves from missing to recorded without changing its value");
    assert.equal(await readStorage(`s.listScores(${JSON.stringify(seed.assessmentId)}).then(rows=>rows.find(x=>x.studentId===${JSON.stringify(seed.students[3].id)})?.rawScore)`), "0");

    await nav("Assessment Center");
    await waitFor("document.querySelector('.assessment-list')", "Assessment Center");
    assert.match(await evaluate("document.querySelector('[data-app]').innerText"), /Synthetic Weekly Check/);
    await nav("Lesson Workspace");
    await waitFor("document.querySelector('[data-lesson-results]')", "Lesson Workspace");
    assert.match(await evaluate("document.querySelector('[data-app]').innerText"), /Synthetic Lesson Plan/);
    const lessonLookup = await evaluate(`(()=>{const input=document.querySelector('.lesson-list-tools input[type=search]');if(!input)throw new Error('Lesson search missing');input.focus();input.value='sYnThEtIc LeSsOn PlAn';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const result={focused:document.activeElement===input,caret:input.selectionStart,visible:document.querySelectorAll('[data-lesson-results] .lesson-card').length,title:document.querySelector('[data-lesson-results] .lesson-card h2')?.textContent};input.value='No Such Lesson';input.dispatchEvent(new Event('input',{bubbles:true}));result.noMatch= document.querySelector('[data-lesson-results] .lesson-empty h2')?.textContent;result.noMatchText=document.querySelector('[data-lesson-results] .lesson-empty p')?.textContent;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));result.cleared=document.querySelectorAll('[data-lesson-results] .lesson-card').length;return result})()`);
    assert.equal(lessonLookup.focused, true, "Lesson search should retain focus while updating results");
    assert.equal(lessonLookup.caret, "sYnThEtIc LeSsOn PlAn".length);
    assert.equal(lessonLookup.visible, 1);
    assert.equal(lessonLookup.title, "Synthetic Lesson Plan");
    assert.equal(lessonLookup.noMatch, "No matching lessons");
    assert.match(lessonLookup.noMatchText, /Try a different title or date/);
    assert.equal(lessonLookup.cleared, 2, "clearing Lesson search should restore the class lesson list");

    await nav("Classroom Mode");
    await waitFor("document.querySelector('#classroom-group-mode')", "Classroom Mode");
    const referenceState = await evaluate("(()=>{const reference=document.querySelector('.classroom-lesson-reference');return {exists:Boolean(reference),open:reference?.open,summary:reference?.querySelector('summary')?.innerText,body:reference?.innerText}})()");
    assert.equal(referenceState.exists, true);
    assert.equal(referenceState.open, false, "lesson details should not crowd the live classroom controls by default");
    assert.match(referenceState.summary, /Synthetic Lesson Plan/);
    assert.match(referenceState.summary, /Planned for today/);
    assert.doesNotMatch(referenceState.summary, /Synthetic Later Plan/);
    await evaluate("document.querySelector('.classroom-lesson-reference').open=true");
    const expandedLessonReference = await evaluate("document.querySelector('.classroom-lesson-reference')?.innerText||''");
    assert.match(expandedLessonReference, /Synthetic learning goal/);
    assert.match(expandedLessonReference, /Compare two examples/);
    assert.doesNotMatch(expandedLessonReference, /Teacher notes|Reflection/);
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      const metrics = await evaluate("(()=>{const summary=document.querySelector('.classroom-lesson-reference summary');return {overflow:document.documentElement.scrollWidth>innerWidth,height:summary?.getBoundingClientRect().height}})()");
      assert.equal(metrics.overflow, false, `lesson reference overflowed at ${width}px`);
      if (width <= 700) assert.ok(metrics.height >= 44, `lesson disclosure target was too small at ${width}px`);
    }
    await setViewport(390, 844);
    await evaluate("document.querySelector('.classroom-lesson-reference summary').focus()");
    assert.equal(await evaluate("document.activeElement===document.querySelector('.classroom-lesson-reference summary')"), true, "lesson reference must be keyboard focusable");
    await page.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await page.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate("document.querySelector('.classroom-lesson-reference')?.open"), true, "Enter should expand the native lesson disclosure");
    await fill('#classroom-group-mode', "");
    await evaluate("document.querySelector('#classroom-group-mode').value='size';document.querySelector('#classroom-group-mode').dispatchEvent(new Event('change',{bubbles:true}))");
    await fill('[aria-label="Maximum students per group"]', "4");
    await clickButton("Make groups");
    await waitFor("document.querySelectorAll('.classroom-group').length>0", "generated classroom groups");
    await clickButton("Display");
    const projectorPrivacy = await evaluate("document.querySelector('.classroom-display')?.innerText||''");
    assert.doesNotMatch(projectorPrivacy, /8\.5 \/ 10|Raw percentage|Attendance rate/);
    assert.doesNotMatch(projectorPrivacy, /Synthetic Lesson Plan|Synthetic learning goal|Compare two examples/, "saved teacher lesson notes must not appear in projector Display Mode");
    await nav("Classroom Mode");

    await nav("Student Progress");
    const progressLookup = await evaluate(`(()=>{const input=document.querySelector('.progress-search input');input.focus();input.value='sYnThEtIc StUdEnT 05';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const result={focused:document.activeElement===input,caret:input.selectionStart,visible:document.querySelector('[data-progress-results] > .progress-student-list')?.querySelectorAll('.progress-student-card').length};input.value='No Such Learner';input.dispatchEvent(new Event('input',{bubbles:true}));result.noMatch=document.querySelector('[data-progress-results] > .progress-student-list .progress-search-empty')?.textContent;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));result.cleared=document.querySelector('[data-progress-results] > .progress-student-list')?.querySelectorAll('.progress-student-card').length;return result})()`);
    assert.equal(progressLookup.focused, true, "Progress search should retain focus while updating results");
    assert.equal(progressLookup.caret, "sYnThEtIc StUdEnT 05".length);
    assert.equal(progressLookup.visible, 1);
    assert.match(progressLookup.noMatch, /No active students match/);
    assert.equal(progressLookup.cleared, 40, "clearing Progress search should restore all active students");
    const archivedLookup = await evaluate(`(()=>{const input=document.querySelector('.progress-search input');input.value='Synthetic Archived Student';input.dispatchEvent(new Event('input',{bubbles:true}));const details=document.querySelector('[data-progress-results] details');const result={open:details?.open,summary:details?.querySelector('summary')?.textContent,archivedMatches:details?.querySelectorAll('.progress-student-card').length,activeMessage:document.querySelector('[data-progress-results] > .progress-student-list .progress-search-empty')?.textContent};input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));result.closedAfterClear=!document.querySelector('[data-progress-results] details')?.open;return result})()`);
    assert.equal(archivedLookup.open, true, "searching an archived student should reveal the matching history instead of hiding it in a collapsed section");
    assert.match(archivedLookup.summary, /1 match/);
    assert.equal(archivedLookup.archivedMatches, 1);
    assert.match(archivedLookup.activeMessage, /No active students match/);
    assert.equal(archivedLookup.closedAfterClear, true, "clearing the search should restore the quiet archived-history disclosure");
    await clickButton("Open summary");
    await waitFor("document.querySelector('.progress-panel')", "student progress summary");
    const progressText = await evaluate("document.querySelector('[data-app]').innerText");
    assert.match(progressText, /Attendance rate/);
    assert.match(progressText, /0 \/ 10/);
    assert.match(progressText, /Synthetic Weekly Check · 0 \/ 10 = 0% raw/, "saved zero remains a recorded score with more historical assessments present");
    await clickButton("Review date");
    await waitFor("document.querySelectorAll('[data-attendance-row]').length===40", "Progress exact-date attendance handoff");
    assert.equal(await evaluate(`document.querySelector('.attendance-date input')?.value`), seed.date);
    assert.equal(await evaluate(`document.activeElement?.getAttribute('data-attendance-row')`), seed.students[0].id, "Progress attendance handoff should focus its source student");
    await clickButton("← Student Progress");
    await waitFor("document.querySelector('.progress-panel')", "return to same Progress student after date review");
    await clickButton("← Student Progress");
    await fill('.progress-search input', "Synthetic Student 05");
    await clickButton("Open summary");
    await waitFor("document.querySelector('.progress-panel')", "missing-score student summary");
    assert.match(await evaluate("document.querySelector('[data-app]').innerText"), /No score entered/);
    await clickButton("Open score entry");
    await waitFor(`document.activeElement?.getAttribute('data-score-input')===${JSON.stringify(seed.students[4].id)}`, "Progress exact-student Gradebook handoff");
    assert.equal(await evaluate(`document.activeElement?.value`), "", "missing remains blank on score-entry handoff");
    await clickButton("← Student Progress");
    await waitFor("document.querySelector('[data-app] h1')?.textContent==='Synthetic Student 05'", "return to exact Progress student after score review");
    await clickButton("← Student Progress");
    await fill('.progress-search input', "Synthetic Student 05");
    await clickButton("Open summary");
    await waitFor("document.querySelector('.progress-panel h2')?.textContent==='Attendance'", "Class Work history for a submitted but ungraded student");
    const ungradedWorkHistory = await evaluate("[...document.querySelectorAll('.progress-panel')].at(-1)?.innerText||document.querySelector('[data-app]').innerText");
    assert.match(ungradedWorkHistory, /Synthetic Chapter 3 Worksheet/);
    assert.match(ungradedWorkHistory, /Submitted · Gradebook: No score entered/);
    await clickButton("Review submissions");
    await waitFor(`document.activeElement?.getAttribute('data-work-status')===${JSON.stringify(seed.students[4].id)}`, "Student Progress to exact Class Work status field");
    assert.equal(await evaluate("document.activeElement.value"), "submitted");
    await clickButton("← Class Work");
    await waitFor("document.querySelector('[data-class-work-list]')", "Class Work list after student history review");
    await nav("Student Progress");
    await fill('.progress-search input', "Synthetic Student 05");
    await clickButton("Open summary");
    await waitFor("document.querySelector('[data-app] h1')?.textContent==='Synthetic Student 05'", "return to the same student after Class Work correction route");
    await nav("Reports");
    assert.equal(await evaluate("document.querySelectorAll('.report-card').length"), 5);
    await clickButton("Open Assessment Results");
    await waitFor("document.querySelector('[data-report-assessment-filter]')", "focused latest Assessment Results report");
    const reportScope = await evaluate(`(()=>({selected:document.querySelector('[data-report-assessment-filter]').selectedOptions[0]?.textContent,reportCount:document.querySelectorAll('.report-assessment').length,rowCount:document.querySelectorAll('.report-assessment .report-table tbody tr').length,note:document.querySelector('.assessment-report-filter .subtle')?.textContent}))()`);
    assert.match(reportScope.selected, /Synthetic Weekly Check/);
    assert.equal(reportScope.reportCount, 1, "report should initially render only the current most-recent assessment");
    assert.equal(reportScope.rowCount, 41, "focused report should include the full active and archived roster");
    assert.match(reportScope.note, /All assessments/);
    const reportAll = await evaluate(`(()=>{const select=document.querySelector('[data-report-assessment-filter]'),started=performance.now();select.value='';select.dispatchEvent(new Event('change',{bubbles:true}));return {focused:document.activeElement===document.querySelector('[data-report-assessment-filter]'),count:document.querySelectorAll('.report-assessment').length,rows:document.querySelectorAll('.report-assessment .report-table tbody tr').length,elapsedMs:performance.now()-started}})()`);
    assert.equal(reportAll.focused, true, "changing report scope should return focus to its selector");
    assert.equal(reportAll.count, 20, "the full assessment history remains available on request");
    assert.equal(reportAll.rows, 820);
    assert.ok(reportAll.elapsedMs < 5000, `rendering the full local assessment history took ${reportAll.elapsedMs}ms`);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, "long Assessment Results output overflows the phone viewport");
    await clickButton("← Reports");
    await waitFor("document.querySelectorAll('.report-card').length===5", "Reports home after reviewing assessment results");
    await clickButton("Open Attendance Summary");
    await waitFor("document.querySelector('[data-report-filter=start]')", "Attendance Summary date filters");
    const dateRange = await evaluate(`(()=>{const from=document.querySelector('[data-report-filter=start]');from.focus();from.value=${JSON.stringify(seed.date)};from.dispatchEvent(new Event('change',{bubbles:true}));const focused=document.activeElement===document.querySelector('[data-report-filter=start]');const to=document.querySelector('[data-report-filter=end]');to.value=${JSON.stringify(seed.date)};to.dispatchEvent(new Event('change',{bubbles:true}));return {focused,from:document.querySelector('[data-report-filter=start]')?.value,to:document.querySelector('[data-report-filter=end]')?.value,summary:document.querySelector('.report-summary')?.innerText,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
    assert.equal(dateRange.focused, true, "changing a report date should retain the active date field");
    assert.equal(dateRange.from, seed.date);
    assert.equal(dateRange.to, seed.date);
    assert.match(dateRange.summary, /40 recorded across 1 date/);
    assert.equal(dateRange.overflow, false);
    await clickButton("← Reports");
    await waitFor("document.querySelectorAll('.report-card').length===5", "Reports home after attendance filtering");
    await clickButton("Open Class Work Status");
    await waitFor("document.querySelectorAll('.report-card').length===1", "Class Work report item selection");
    assert.match(await evaluate("document.querySelector('.report-card').innerText"), /3 submitted · 1 missing · 1 excused · 35 not recorded/);
    await clickButton("Open status report");
    await waitFor("document.querySelector('.report-table-wrap--compact')", "Class Work status report");
    assert.match(await evaluate("document.querySelector('.report-summary').innerText"), /40 active · 1 archived/);
    assert.match(await evaluate("document.querySelector('.report-summary').innerText"), /Submitted 3 · Missing 1 · Excused 1 · Not recorded 35/);
    assert.equal(await evaluate("document.querySelectorAll('.report-table tbody tr').length"), 41);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, "Class Work report overflows mobile viewport");
    for (const [width, height] of [[1280, 900], [768, 1024], [390, 844], [320, 740]]) {
      await setViewport(width, height);
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `Class Work status report overflows at ${width}px`);
    }
    await setViewport(390, 844);
    await clickButton("← Reports");
    await waitFor("document.querySelectorAll('.report-card').length===5", "Reports home after Class Work report");
    await clickButton("Open Class Roster");
    assert.match(await evaluate("document.querySelector('.report-summary').innerText"), /40 active · 1 archived/);
    await nav("My Materials");
    assert.equal(await evaluate("document.querySelectorAll('.material-card').length"), 2);
    const materialLookup = await evaluate(`(()=>{const input=document.querySelector('.materials-tools input[type=search]');input.focus();input.value='sYnThEtIc LeSsOn';input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));const result={focused:document.activeElement===input,caret:input.selectionStart,visible:document.querySelectorAll('.material-card').length};input.value='No Such Material';input.dispatchEvent(new Event('input',{bubbles:true}));result.noMatch=document.querySelector('[data-material-results] .library-empty h2')?.textContent;input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));result.cleared=document.querySelectorAll('.material-card').length;return result})()`);
    assert.equal(materialLookup.focused, true, "My Materials search should retain focus while updating results");
    assert.equal(materialLookup.caret, "sYnThEtIc LeSsOn".length);
    assert.equal(materialLookup.visible, 1);
    assert.equal(materialLookup.noMatch, "No matching materials");
    assert.equal(materialLookup.cleared, 2, "clearing My Materials search should restore all templates");
    const materialReturnTarget = await evaluate("(()=>{const b=[...document.querySelectorAll('.materials-heading button')].find(x=>x.textContent.trim()==='Return to Synthetic Release QA');const r=b?.getBoundingClientRect();return {exists:Boolean(b),height:r?.height,width:r?.width,scrollWidth:document.documentElement.scrollWidth}})()");
    assert.equal(materialReturnTarget.exists, true);
    assert.ok(materialReturnTarget.height >= 44, "the contextual class-return action is too small on mobile");
    assert.equal(materialReturnTarget.scrollWidth <= 390, true, "My Materials actions overflow the mobile viewport");
    await clickButton("Return to Synthetic Release QA");
    await waitFor("document.querySelector('.today-workspace')", "return from My Materials to its source class");

    await nav("My Materials");
    await nav("My Classes");
    await nav("My Materials");
    const unscopedMaterials = await evaluate("(()=>({returnAction:[...document.querySelectorAll('.materials-heading button')].some(x=>x.textContent.startsWith('Return to ')),addLabels:[...document.querySelectorAll('.material-card-actions .button--small')].map(x=>x.textContent.trim())}))()");
    assert.equal(unscopedMaterials.returnAction, false, "leaving a class-scoped Materials visit for My Classes must clear the old class context");
    assert.equal(unscopedMaterials.addLabels.every((label) => label === "Add to a class"), true, "classless Materials should not keep suggesting a stale destination");
    await nav("My Classes");
    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('original class missing after clearing Materials context');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('.today-workspace')", "main class after clearing Materials context");

    await nav("Gradebook");
    await clickButton("Switch class");
    await waitFor("document.querySelector('[data-dialog=class-tool]')?.open", "class switch chooser");
    const switchChoices = await evaluate("[...document.querySelectorAll('[data-dialog=class-tool] .class-tool-choice')].map(x=>({name:x.querySelector('.class-tool-choice-name')?.textContent,details:x.querySelector('.class-tool-choice-details')?.textContent}))");
    assert.equal(switchChoices.length, 7, "the multi-class switcher should list every other active destination");
    assert.equal(switchChoices.some((choice) => choice.name === "Synthetic Release QA"), false, "the open class must not appear as its own switch destination");
    assert.ok(switchChoices.some((choice) => choice.name === "Synthetic Release QA Second" && choice.details === "Grade 7 · Mathematics · 2026–2027 · Tue/Thu · 9:00 AM · 35 active students"), "class choices should expose useful existing identity and roster context");
    const switchDialogMetrics = await evaluate("(()=>{const d=document.querySelector('[data-dialog=class-tool]'),r=d.getBoundingClientRect(),choices=[...d.querySelectorAll('.class-tool-choice')];return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,targets:choices.map(x=>x.getBoundingClientRect().height),focused:choices.includes(document.activeElement),scrollWidth:document.documentElement.scrollWidth}})()");
    assert.ok(switchDialogMetrics.left >= 0 && switchDialogMetrics.right <= switchDialogMetrics.width && switchDialogMetrics.top >= 0 && switchDialogMetrics.bottom <= switchDialogMetrics.height, "class switch dialog should fit the phone viewport");
    assert.ok(switchDialogMetrics.targets.every((height) => height >= 44), "class destination controls should meet practical phone target size");
    assert.equal(switchDialogMetrics.focused, true, "opening the class switcher should focus its first destination");
    assert.equal(switchDialogMetrics.scrollWidth <= switchDialogMetrics.width, true, "class switcher should not overflow horizontally");
    await evaluate(`(()=>{const b=[...document.querySelectorAll('[data-dialog=class-tool] .class-tool-choice')].find(x=>x.textContent.includes('Synthetic Release QA Second'));if(!b)throw new Error('second class choice missing');b.click()})()`);
    await waitFor("document.querySelector('.nav-class-context-name')?.textContent==='Synthetic Release QA Second'", "class switch retaining Gradebook");
    await waitFor("document.querySelector('.empty-state h2')?.textContent==='No assessments yet'", "target-class Gradebook isolation");
    assert.equal(await evaluate("document.querySelector('[data-nav-item=Gradebook]').getAttribute('aria-current')"), "page");
    await nav("Overview");
    const fallbackLesson = await evaluate("(()=>({title:document.querySelector('.today-card--lesson h3')?.textContent,detail:document.querySelector('.today-card--lesson')?.innerText}))()");
    assert.equal(fallbackLesson.title, "Synthetic Recently Edited Plan", "when no lesson is dated today, Today should use the most recently edited lesson for the selected class");
    assert.match(fallbackLesson.detail, /Recently edited/);
    assert.match(fallbackLesson.detail, /Lesson date/);
    await nav("My Classes");
    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('original class card missing on switch-back');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('[data-roster-results] .roster-list li')", "original class roster after switching back");
    assert.equal(await evaluate("document.querySelector('[data-roster-search]')?.value"), "", "student lookup must not leak across class switches");
    assert.equal(await evaluate("document.querySelectorAll('[data-roster-results] .roster-list li').length"), 40);
    await nav("My Classes");
    await page.call("Page.reload");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "reopen persistence");
    const persistedClassVisible = await evaluate("(()=>({found:[...document.querySelectorAll('.class-card h2')].some(x=>x.textContent==='Synthetic Release QA'),body:document.querySelector('[data-app]')?.innerText?.slice(0,900),url:location.href,classes:[...document.querySelectorAll('.class-card h2')].map(x=>x.textContent)}))()");
    assert.equal(persistedClassVisible.found, true, `main class missing after reload: ${JSON.stringify(persistedClassVisible)}`);

    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('main class missing before offline');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('.today-workspace')", "reopen main class before offline");

    await waitFor(`navigator.serviceWorker.ready.then(r=>Boolean(r.active?.scriptURL.includes('sw.js?v=${shellVersion}'))) `, `service worker ${currentCacheName} activation`, 15000);
    const workerRegistration = await evaluate("navigator.serviceWorker.ready.then(r=>({scope:r.scope,script:r.active?.scriptURL}))");
    assert.equal(workerRegistration.scope, `${origin}/`);
    assert.ok(workerRegistration.script.endsWith(`/sw.js?v=${shellVersion}`));
    await page.call("Page.reload");
    try { await waitFor("navigator.serviceWorker.controller!==null", "service worker control after reload", 10000); }
    catch (error) {
      const serviceWorkerState = await evaluate("(async()=>({url:location.href,controller:navigator.serviceWorker.controller?.scriptURL||null,registrations:(await navigator.serviceWorker.getRegistrations()).map(r=>({scope:r.scope,active:r.active?.scriptURL,state:r.active?.state,waiting:r.waiting?.scriptURL,installing:r.installing?.state}))}))()");
      throw new Error(`${error.message}; state=${JSON.stringify(serviceWorkerState)}`);
    }
    const cachesBeforeOffline = await evaluate(`(async()=>{const names=await caches.keys(),shell=await caches.open(${JSON.stringify(currentCacheName)}),keys=await shell.keys();const urls=keys.map(x=>new URL(x.url).pathname);const all=await Promise.all(keys.map(x=>x.clone().text()));return {names,urls,hasStudentData:all.some(x=>x.includes('Synthetic Student 01')||x.includes('Synthetic Release QA'))}})()`);
    assert.ok(cachesBeforeOffline.names.includes(currentCacheName));
    for (const staleName of staleCacheNames) assert.equal(cachesBeforeOffline.names.includes(staleName), false, `${staleName} should be removed after activation`);
    assert.ok(cachesBeforeOffline.urls.some((url) => url.endsWith("/lesson-reference.js")));
    assert.equal(cachesBeforeOffline.hasStudentData, false);
    assert.ok(cachesBeforeOffline.urls.some((url) => url.endsWith("/app.js")));
    await page.call("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: "none" });
    await page.call("Page.reload");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "cold app startup while offline", 15000);
    assert.equal(await evaluate("navigator.onLine"), false);
    assert.equal(await readStorage(`s.listStudents(${JSON.stringify(seed.classId)}).then(x=>x.length)`), 40);
    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('synthetic class missing offline');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('.today-workspace')", "offline class overview");
    await nav("Attendance");
    await waitFor("document.querySelectorAll('[data-attendance-row]').length===40", "offline attendance workspace");
    const offlineSavedStudent = seed.students[4].id;
    await evaluate(`document.querySelector('[data-attendance-row=${JSON.stringify(offlineSavedStudent)}] [data-attendance-status=late]').click()`);
    await clickButton("Save attendance");
    await waitFor("[...document.querySelectorAll('[data-attendance-save-state]')].some(x=>x.textContent==='Saved on this device')", "offline attendance save");
    const offlineAttendanceStatus = await readStorage(`s.listAttendanceForDate(${JSON.stringify(seed.classId)},${JSON.stringify(seed.date)}).then(rows=>rows.find(x=>x.studentId===${JSON.stringify(offlineSavedStudent)})?.status)`);
    assert.equal(offlineAttendanceStatus, "late");
    await page.call("Page.reload");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "offline saved-data reopen", 15000);
    assert.equal(await evaluate("navigator.onLine"), false);
    assert.equal(await readStorage(`s.listAttendanceForDate(${JSON.stringify(seed.classId)},${JSON.stringify(seed.date)}).then(rows=>rows.find(x=>x.studentId===${JSON.stringify(offlineSavedStudent)})?.status)`), "late");
    await evaluate(`(()=>{const card=[...document.querySelectorAll('.class-card')].find(x=>x.querySelector('h2')?.textContent==='Synthetic Release QA');if(!card)throw new Error('synthetic class missing after offline save reload');card.querySelector('button').click()})()`);
    await waitFor("document.querySelector('.today-workspace')", "offline class overview after save reload");
    await nav("Attendance");
    await waitFor("document.querySelectorAll('[data-attendance-row]').length===40", "offline saved attendance reopen");
    assert.equal(await evaluate(`document.querySelector('[data-attendance-row=${JSON.stringify(offlineSavedStudent)}] [data-attendance-status=late]').getAttribute('aria-checked')`), "true");
    await nav("Classroom Mode");
    await waitFor("document.querySelector('#classroom-group-mode')", "offline Classroom Mode");
    assert.equal(await evaluate("Boolean(document.querySelector('.classroom-lesson-reference'))"), true, "saved lesson reference should remain available offline");
    await nav("Student Progress");
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-progress-results] .progress-student-list')].map(x=>x.querySelectorAll('.progress-student-card').length)"), [40, 1]);
    await nav("Class Work");
    await clickButton("Review submissions");
    await waitFor("document.querySelectorAll('[data-work-status]').length===40", "offline Class Work startup");
    assert.equal(await evaluate(`document.querySelector('[data-work-status=${JSON.stringify(seed.students[0].id)}]')?.value`), "submitted", "offline Class Work must retain its saved submission status");
    assert.equal(await evaluate(`document.querySelector('[data-work-status=${JSON.stringify(seed.students[3].id)}]')?.value`), "submitted", "offline submitted-but-ungraded status must remain available");
    await page.call("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "wifi" });
    await pause(250);

    await nav("My Classes");
    await clickButton("Backup & restore");
    await clickButton("Download encrypted backup");
    const passphrase = `synthetic-${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
    await fill('[data-dialog="backup-encrypt"] input[name="passphrase"]', passphrase);
    await fill('[data-dialog="backup-encrypt"] input[name="confirmPassphrase"]', passphrase);
    await evaluate("document.querySelector('[data-dialog=backup-encrypt] input[name=understandPassphrase]').checked=true;document.querySelector('[data-dialog=backup-encrypt] input[name=understandPassphrase]').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('[data-dialog=backup-encrypt] form').requestSubmit()");
    await waitFor("document.querySelector('[data-live]').textContent.includes('download started')", "encrypted backup export", 15000);
    let backupFile;
    for (let attempt = 0; attempt < 60 && !backupFile; attempt++) {
      backupFile = (await readdir(downloads)).map((name) => join(downloads, name)).find((path) => path.endsWith(".json"));
      if (!backupFile) await pause(100);
    }
    assert.ok(backupFile, "Chrome did not produce the encrypted backup file");
    assert.ok((await stat(backupFile)).size > 0);
    const envelopeText = await readFile(backupFile, "utf8");
    assert.doesNotMatch(envelopeText, /Synthetic Release QA|Synthetic Student 01|Synthetic Chapter 3 Worksheet|synthetic question/i);
    assert.equal(envelopeText.includes(passphrase), false);
    assert.match(await evaluate("document.querySelector('.backup-recency strong')?.textContent"), /Backup download started: Today/);
    assert.equal((await evaluate("JSON.stringify(Object.values(localStorage))")).includes(passphrase), false);
    const temporary = await readStorage(`s.saveClass({className:'Synthetic Must Remain After Wrong Passphrase'}).then(x=>x.className)`);
    assert.equal(temporary, "Synthetic Must Remain After Wrong Passphrase");
    await clickButton("Choose backup file");
    const { root } = await page.call("DOM.getDocument", { depth: -1 });
    const { nodeId } = await page.call("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-dialog="backup"] input[type="file"]' });
    await page.call("DOM.setFileInputFiles", { nodeId, files: [backupFile] });
    await waitFor("document.querySelector('[data-dialog=backup-unlock]')?.open", "encrypted backup file input");
    await fill('[data-dialog="backup-unlock"] input[name="passphrase"]', `${passphrase}-wrong`);
    await evaluate("document.querySelector('[data-dialog=backup-unlock] form').requestSubmit()");
    await waitFor("document.querySelector('[data-dialog=backup-unlock] [data-operation-error]')", "wrong passphrase rejection", 60000);
    assert.equal(await readStorage(`s.listClasses().then(x=>x.some(c=>c.className==='Synthetic Must Remain After Wrong Passphrase'))`), true);
    await fill('[data-dialog="backup-unlock"] input[name="passphrase"]', passphrase);
    await evaluate("document.querySelector('[data-dialog=backup-unlock] form').requestSubmit()");
    await waitFor("document.querySelector('[data-dialog=restore]')?.open", "authenticated restore review");
    const restoreSummary = await evaluate("document.querySelector('[data-dialog=restore] [data-restore-summary]').textContent");
    assert.match(restoreSummary, /286 student records/);
    assert.match(restoreSummary, /1 class-work items/);
    assert.match(restoreSummary, /5 submission statuses/);
    const restoreProgress = await evaluate("(()=>{const dialog=document.querySelector('[data-dialog=restore]'),form=dialog.querySelector('form'),progress=form.querySelector('[data-restore-progress]');form.elements.replace.checked=true;form.elements.replace.dispatchEvent(new Event('change',{bubbles:true}));form.requestSubmit();const busyAfterSubmit=form.getAttribute('aria-busy'),firstSubmitDisabled=form.querySelector('[type=submit]').disabled,closeDisabled=[...form.querySelectorAll('button[data-close-dialog]')].every(button=>button.disabled),status=progress.textContent;form.requestSubmit();const cancelEvent=new Event('cancel',{cancelable:true});dialog.dispatchEvent(cancelEvent);return {busyAfterSubmit,firstSubmitDisabled,closeDisabled,status,cancelPrevented:cancelEvent.defaultPrevented}})()");
    assert.deepEqual(restoreProgress, { busyAfterSubmit: "true", firstSubmitDisabled: true, closeDisabled: true, status: "Restoring this backup… Keep this window open. Larger backups may take a little while.", cancelPrevented: true }, "restore must communicate pending work, prevent duplicate submit, and remain visibly non-cancellable while replacement is in progress");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "backup restore return", 15000);
    const restored = await readStorage(`(async()=>{const classes=await s.listClasses(),students=await s.listStudents(${JSON.stringify(seed.classId)}),archivedStudents=await s.listStudents(${JSON.stringify(seed.classId)},{archived:true}),attendance=await s.listAttendanceRecords(${JSON.stringify(seed.classId)}),assessments=await s.listAssessments(${JSON.stringify(seed.classId)}),scores=await s.listScoresForClass(${JSON.stringify(seed.classId)}),lessons=await s.listLessons(${JSON.stringify(seed.classId)}),materials=await s.listMaterials(),questions=await s.listQuestions(${JSON.stringify(seed.assessmentId)}),classWork=await s.listClassWork(${JSON.stringify(seed.classId)}),workSubmissions=await s.listWorkSubmissionsForItem(${JSON.stringify(classWorkItemId)});return {classes:classes.map(x=>x.className),students:students.length,archivedStudents:archivedStudents.length,attendance:attendance.length,assessments:assessments.length,scores:scores.map(({assessmentId,studentId,rawScore})=>({assessmentId,studentId,rawScore})),lessons:lessons.map(({title,date})=>({title,date})),materials:materials.length,questions:questions.map(({prompt,correctOptionId,options})=>({prompt,correctOptionId,options:options.map(({id,text})=>({id,text}))})),classWork:classWork.map(({id,title,dueDate,assessmentId})=>({id,title,dueDate,assessmentId})),workSubmissions:workSubmissions.map(({studentId,status})=>({studentId,status}))}})()`);
    assert.deepEqual(restored.classes.sort(), ["Synthetic Release QA", "Synthetic Release QA Second", "Synthetic Section 03", "Synthetic Section 04", "Synthetic Section 05", "Synthetic Section 06", "Synthetic Section 07", "Synthetic Section 08"].sort());
    assert.equal(restored.students, 40);
    assert.equal(restored.archivedStudents, 1);
    assert.ok(restored.attendance >= 40);
    assert.equal(restored.assessments, 20);
    assert.equal(restored.scores.length, 47);
    assert.equal(restored.scores.find((score) => score.assessmentId === seed.assessmentId && score.studentId === seed.students[0].id)?.rawScore, "0");
    assert.equal(restored.scores.find((score) => score.assessmentId === seed.assessmentId && score.studentId === seed.students[1].id)?.rawScore, "8.5");
    assert.equal(restored.scores.find((score) => score.assessmentId === seed.assessmentId && score.studentId === seed.students[2].id)?.rawScore, "6");
    assert.equal(restored.scores.find((score) => score.assessmentId === seed.assessmentId && score.studentId === seed.students[3].id)?.rawScore, "0", "a saved zero remains distinct from other missing students");
    assert.equal(restored.scores.find((score) => score.assessmentId === seed.assessmentId && score.studentId === seed.archivedId)?.rawScore, "5", "archived-student history remains preserved in backup restore");
    assert.equal(restored.lessons.length, 2);
    assert.ok(restored.lessons.some((lesson) => lesson.title === "Synthetic Lesson Plan" && lesson.date === seed.date), "backup restore preserves the class lesson reference and its local date");
    assert.ok(restored.lessons.some((lesson) => lesson.title === "Synthetic Later Plan"));
    assert.equal(restored.materials, 2);
    assert.equal(restored.questions.length, 1);
    assert.equal(restored.questions[0].prompt, "Synthetic question?");
    assert.equal(restored.questions[0].options.length, 2);
    assert.ok(restored.questions[0].options.some((option) => option.id === restored.questions[0].correctOptionId));
    assert.deepEqual(restored.classWork, [{ id: classWorkItemId, title: "Synthetic Chapter 3 Worksheet", dueDate: seed.date, assessmentId: seed.assessmentId }]);
    assert.equal(restored.workSubmissions.length, 5);
    assert.equal(restored.workSubmissions.find((entry) => entry.studentId === seed.students[0].id)?.status, "submitted");
    assert.equal(restored.workSubmissions.find((entry) => entry.studentId === seed.students[1].id)?.status, "missing");
    assert.equal(restored.workSubmissions.find((entry) => entry.studentId === seed.students[2].id)?.status, "excused");
    assert.equal(restored.workSubmissions.find((entry) => entry.studentId === seed.students[4].id)?.status, "submitted");

    const schoolYearScale = await readStorage(`(async()=>{const request=indexedDB.open('teacher-workspace'),db=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)}),names=['classes','students','attendance','assessments','scores','lessons','classWork','workSubmissions'],tx=db.transaction(names,'readwrite'),stores=Object.fromEntries(names.map(name=>[name,tx.objectStore(name)])),now=new Date().toISOString(),classIds=[],rosters=[],assessmentIds=[];for(let ci=0;ci<8;ci++){const classId='scale-class-'+ci;classIds.push(classId);stores.classes.put({id:classId,className:'Scale School Year '+String(ci+1).padStart(2,'0'),gradeLevel:'Grade 7',subject:'Science',term:'2025-2026',schedule:'',notes:'',archivedAt:null,type:'class',createdAt:now,updatedAt:now});const studentIds=[];for(let si=0;si<40;si++){const studentId='scale-student-'+ci+'-'+si;studentIds.push(studentId);stores.students.put({id:studentId,classId,fullName:'Scale '+String(ci+1).padStart(2,'0')+' Student '+String(si+1).padStart(2,'0'),normalizedName:'scale '+ci+' student '+si,archivedAt:null,type:'student',createdAt:now,updatedAt:now})}rosters.push(studentIds);const ids=[];for(let ai=0;ai<8;ai++){const assessmentId='scale-assessment-'+ci+'-'+ai;ids.push(assessmentId);const date=new Date(Date.UTC(2025,1,1+ai)).toISOString().slice(0,10);stores.assessments.put({id:assessmentId,classId,title:'Scale check '+(ai+1),date,classDate:classId+'::'+date,maximumScore:'20',category:'Quiz',term:'2025-2026',policyId:'generic-raw-v1',instructions:'',assessmentKind:'quiz',authoringStatus:'draft',showPoints:false,type:'assessment',createdAt:now,updatedAt:now});for(let si=0;si<40;si++)if(si%8!==0){const studentId=studentIds[si];stores.scores.put({id:'scale-score-'+ci+'-'+ai+'-'+si,assessmentId,classId,studentId,assessmentStudent:assessmentId+'::'+studentId,rawScore:String((si+ai)%21),type:'score',createdAt:now,updatedAt:now})}}assessmentIds.push(ids);for(let li=0;li<12;li++)stores.lessons.put({id:'scale-lesson-'+ci+'-'+li,classId,title:'Scale lesson '+(li+1),date:'',status:'draft',learningGoals:'',priorKnowledge:'',materials:'',before:'',during:'',checkForUnderstanding:'',assessment:'',reflection:'',nextStep:'',notes:'',type:'lesson',createdAt:now,updatedAt:now});for(let wi=0;wi<12;wi++){const workItemId='scale-work-'+ci+'-'+wi;stores.classWork.put({id:workItemId,classId,title:'Scale work '+(wi+1),dueDate:'',assessmentId:ids[wi%ids.length],type:'class-work',createdAt:now,updatedAt:now});for(let si=0;si<40;si++)if(si%5!==0){const studentId=studentIds[si],status=['submitted','missing','excused'][(si+wi)%3];stores.workSubmissions.put({id:'scale-submission-'+ci+'-'+wi+'-'+si,classId,workItemId,studentId,status,type:'work-submission',createdAt:now,updatedAt:now})}}for(let day=0;day<180;day++){const date=new Date(Date.UTC(2025,0,1+day)).toISOString().slice(0,10);for(let si=0;si<40;si++){const studentId=studentIds[si],status=si%17===day%17?'absent':si%19===day%19?'late':'present';stores.attendance.put({id:'scale-attendance-'+ci+'-'+day+'-'+si,classId,studentId,date,classDate:classId+'::'+date,status,type:'attendance',createdAt:now,updatedAt:now})}}}await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)});db.close();const classId=classIds[3],readStarted=performance.now(),[classes,students,attendance,assessments,scores,lessons,classWork,submissions]=await Promise.all([s.listClasses(),s.listStudents(classId),s.listAttendanceRecords(classId),s.listAssessments(classId),s.listScoresForClass(classId),s.listLessons(classId),s.listClassWork(classId),s.listWorkSubmissionsForClass(classId)]),readMs=performance.now()-readStarted,[progressModule,reportsModule,workModule]=await Promise.all([import('./progress.js'),import('./reports.js'),import('./class-work.js')]),deriveStarted=performance.now(),progress=progressModule.deriveStudentProgress({student:students[0],classId,attendance,assessments,scores,classWork,workSubmissions:submissions}),report=reportsModule.deriveAttendanceSummary({classId,students,attendance}),workSummaries=workModule.deriveClassWorkCountsByItem({classId,workItems:classWork,students,submissions}),deriveMs=performance.now()-deriveStarted,backupStarted=performance.now(),backup=await s.createBackup(),backupMs=performance.now()-backupStarted,backupBytes=new TextEncoder().encode(JSON.stringify(backup)).length,recordCounts=Object.fromEntries(Object.entries(backup.data).map(([name,records])=>[name,records.length])),storageEstimate=await navigator.storage.estimate();return {classCount:classes.length,students:students.length,attendance:attendance.length,assessments:assessments.length,scores:scores.length,lessons:lessons.length,classWork:classWork.length,submissions:submissions.length,progressAttendance:progress.attendance.length,progressMissingScores:progress.scoreSummary.missingCount,reportAttendanceRows:report.recordedCount,workSummaryCount:workSummaries.size,readMs,deriveMs,backupMs,backupBytes,recordCounts,storageUsage:storageEstimate.usage||0}})()`);
    assert.deepEqual({ classes: schoolYearScale.classCount, students: schoolYearScale.students, attendance: schoolYearScale.attendance, assessments: schoolYearScale.assessments, scores: schoolYearScale.scores, lessons: schoolYearScale.lessons, classWork: schoolYearScale.classWork, submissions: schoolYearScale.submissions }, { classes: 16, students: 40, attendance: 7200, assessments: 8, scores: 280, lessons: 12, classWork: 12, submissions: 384 });
    assert.equal(schoolYearScale.progressAttendance, 180);
    assert.equal(schoolYearScale.progressMissingScores, 8, "native scale history continues to distinguish missing scores");
    assert.equal(schoolYearScale.reportAttendanceRows, 7200);
    assert.equal(schoolYearScale.workSummaryCount, 12);
    assert.ok(schoolYearScale.readMs < 10000, `native IndexedDB class-scoped reads took ${schoolYearScale.readMs.toFixed(1)} ms`);
    const schoolYearEncryptedExport = await readStorage(`(async()=>{const backup=await s.createBackup(),cryptoModule=await import('./backup-crypto.js'),encrypted=await cryptoModule.encryptBackup(backup,'synthetic-scale-export-passphrase'),fileBytes=new TextEncoder().encode(JSON.stringify(encrypted)).length;cryptoModule.validateEncryptedBackupEnvelope(encrypted);return {plainBytes:new TextEncoder().encode(JSON.stringify(backup)).length,fileBytes,fileLimit:cryptoModule.MAX_ENCRYPTED_BACKUP_FILE_BYTES}})()`);
    assert.ok(schoolYearEncryptedExport.plainBytes > 14 * 1024 * 1024, "fixture should exceed the previous ciphertext ceiling");
    assert.ok(schoolYearEncryptedExport.fileBytes <= schoolYearEncryptedExport.fileLimit, "a realistic school-year encrypted export must fit the matching import limit");
    const schoolYearRestore = await readStorage(`(async()=>{const backup=await s.createBackup(),cryptoModule=await import('./backup-crypto.js'),encrypted=await cryptoModule.encryptBackup(backup,'synthetic-scale-export-passphrase'),decrypted=await cryptoModule.decryptBackup(encrypted,'synthetic-scale-export-passphrase'),started=performance.now(),restored=await s.replaceWithBackup(decrypted);return {...restored,restoreMs:performance.now()-started}})()`);
    assert.equal(schoolYearRestore.attendanceCount, schoolYearScale.recordCounts.attendance, "encrypted school-year restore preserves the full attendance history");
    assert.equal(schoolYearRestore.scoreCount, schoolYearScale.recordCounts.scores);
    assert.equal(schoolYearRestore.workSubmissionCount, schoolYearScale.recordCounts.workSubmissions);
    t.diagnostic(`Native IndexedDB scale (8 × 40 × 180 attendance): class reads ${schoolYearScale.readMs.toFixed(1)} ms; Progress/Reports/Work derivation ${schoolYearScale.deriveMs.toFixed(1)} ms; backup ${schoolYearScale.backupMs.toFixed(1)} ms / ${schoolYearScale.backupBytes} JSON bytes; encrypted export ${schoolYearEncryptedExport.fileBytes} bytes; encrypted restore ${schoolYearRestore.restoreMs.toFixed(1)} ms; origin usage ${schoolYearScale.storageUsage} bytes.`);

    await browser.call("Target.createTarget", { url: `${origin}/?second-tab=1` });
    await pause(400);
    const lockTab = (await (await fetch(`${cdpHttp}/json/list`)).json()).find((item) => item.type === "page" && item.url.includes("second-tab=1"));
    assert.ok(lockTab, "second tab was not opened");
    const second = cdp(lockTab.webSocketDebuggerUrl); await second.ready;
    second.on("Runtime.exceptionThrown", (event) => consoleIssues.push(event.exceptionDetails?.text || "uncaught exception in recovery tab"));
    second.on("Log.entryAdded", (event) => { if (["error", "warning"].includes(event.entry.level)) consoleIssues.push(`${event.entry.level} in recovery tab: ${event.entry.text}`); });
    second.on("Network.requestWillBeSent", (event) => pageRequests.push({ url: event.request.url, method: event.request.method }));
    let secondState = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-dialog=workspace-lock]')?.open && [document.querySelector('[data-workspace-retry]')?.textContent.trim(),document.querySelector('[data-workspace-takeover]')?.textContent.trim()]", returnByValue: true });
      secondState = response.result.value?.[0] === "Try again" && response.result.value?.[1] === "Take over workspace…";
      if (secondState) break;
      await pause(100);
    }
    assert.equal(secondState, true, "a blocked window must offer both a normal retry and an explicit stale-window recovery path");
    const lockedStatus = await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
    assert.match(lockedStatus.result.value, /another window/);
    await page.call("Page.setWebLifecycleState", { state: "frozen" });
    await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-workspace-takeover]')?.click();true", returnByValue: true });
    const takeoverReview = await second.call("Runtime.evaluate", { expression: "({open:document.querySelector('[data-dialog=workspace-takeover]')?.open,text:document.querySelector('[data-workspace-takeover-copy]')?.textContent})", returnByValue: true });
    assert.equal(takeoverReview.result.value.open, true);
    assert.match(takeoverReview.result.value.text, /read-only[\s\S]*unsaved edits[\s\S]*saved records/);
    await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-confirm-workspace-takeover]')?.click();true", returnByValue: true });
    await page.call("Page.setWebLifecycleState", { state: "active" });
    let reopenedStorage = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
      reopenedStorage = status.result.value || "";
      if (reopenedStorage.includes("ready")) break;
      await pause(100);
    }
    assert.match(reopenedStorage, /ready/i, "explicit takeover did not recover the editor from a frozen lock owner");
    await second.call("Runtime.evaluate", { expression: "document.querySelector('[data-nav-item=\\\"My Classes\\\"]')?.click();true", returnByValue: true });
    let secondClass = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const status = await second.call("Runtime.evaluate", { expression: "[...document.querySelectorAll('.class-card h2')].some(x=>x.textContent==='Synthetic Release QA')", returnByValue: true });
      secondClass = status.result.value;
      if (secondClass) break;
      await pause(100);
    }
    assert.equal(secondClass, true, "takeover did not preserve and reopen saved synthetic data");
    const secondDialogs = await second.call("Runtime.evaluate", { expression: "[...document.querySelectorAll('dialog[open]')].length", returnByValue: true });
    assert.equal(secondDialogs.result.value, 0, "the lock/recovery overlay must be removed after successful takeover");
    let oldWindowLocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await page.call("Runtime.evaluate", { expression: "({url:location.href,open:document.querySelector('[data-dialog=workspace-lock]')?.open,status:document.querySelector('[data-storage-message]')?.textContent,copy:document.querySelector('[data-workspace-lock-copy]')?.textContent})", returnByValue: true });
      const current = status.result.value;
      oldWindowLocked = current?.open && current.url.includes("workspace-locked=1") && /another window/i.test(current.status || "");
      if (oldWindowLocked) break;
      await pause(100);
    }
    assert.equal(oldWindowLocked, true, "the frozen previous owner must be navigated to the new app's blocked/recovery screen");
    const staleWrite = await page.call("Runtime.evaluate", { expression: "import('./storage.js').then(async s=>{try{await s.saveClass({className:'Must not be saved by stale window'});return {rejected:false}}catch(error){return {rejected:true,message:error.message}}})", awaitPromise: true, returnByValue: true });
    assert.equal(staleWrite.result.value.rejected, true, "a stolen/frozen old editor must not perform a later IndexedDB write");
    assert.match(staleWrite.result.value.message, /no longer has editing access/);

    await browser.call("Target.createTarget", { url: `${origin}/?retry-after-close=1` });
    await pause(400);
    const retryTab = (await (await fetch(`${cdpHttp}/json/list`)).json()).find((item) => item.type === "page" && item.url.includes("retry-after-close=1"));
    assert.ok(retryTab, "retry tab was not opened");
    const retry = cdp(retryTab.webSocketDebuggerUrl); await retry.ready;
    retry.on("Runtime.exceptionThrown", (event) => consoleIssues.push(event.exceptionDetails?.text || "uncaught exception in retry tab"));
    let retryLocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await retry.call("Runtime.evaluate", { expression: "document.querySelector('[data-dialog=workspace-lock]')?.open", returnByValue: true });
      if (status.result.value) { retryLocked = true; break; }
      await pause(100);
    }
    assert.equal(retryLocked, true, "a third window must remain blocked while the current editor owns the lock");
    await browser.call("Target.closeTarget", { targetId: lockTab.id });
    await pause(500);
    await retry.call("Runtime.evaluate", { expression: "document.querySelector('[data-workspace-retry]')?.click();true", returnByValue: true });
    let retryReady = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await retry.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
      retryReady = status.result.value || "";
      if (/ready/i.test(retryReady)) break;
      await pause(100);
    }
    assert.match(retryReady, /ready/i, "Retry must acquire normally after the real owner closes");
    const retryData = await retry.call("Runtime.evaluate", { expression: "import('./storage.js').then(s=>s.listClasses()).then(classes=>classes.some(x=>x.className==='Synthetic Release QA'))", awaitPromise: true, returnByValue: true });
    assert.equal(retryData.result.value, true, "Retry after close must preserve existing IndexedDB records");
    await retry.call("Page.reload");
    let refreshedReady = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await retry.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
      refreshedReady = status.result.value || "";
      if (/ready/i.test(refreshedReady)) break;
      await pause(100);
    }
    assert.match(refreshedReady, /ready/i, "refresh must release and reacquire the workspace lock normally");
    const refreshData = await retry.call("Runtime.evaluate", { expression: "import('./storage.js').then(s=>s.listClasses()).then(classes=>classes.some(x=>x.className==='Synthetic Release QA'))", awaitPromise: true, returnByValue: true });
    assert.equal(refreshData.result.value, true, "refresh must preserve saved IndexedDB records");
    retry.close();
    await browser.call("Target.closeTarget", { targetId: retryTab.id });
    await browser.call("Target.closeTarget", { targetId });
    second.close();
    await pause(300);

    const failureTarget = await browser.call("Target.createTarget", { url: "about:blank" });
    const failureTab = (await (await fetch(`${cdpHttp}/json/list`)).json()).find((item) => item.id === failureTarget.targetId);
    assert.ok(failureTab?.webSocketDebuggerUrl, "storage-failure test tab was not created");
    const failurePage = cdp(failureTab.webSocketDebuggerUrl); await failurePage.ready;
    await Promise.all([failurePage.call("Page.enable"), failurePage.call("Runtime.enable")]);
    await failurePage.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__releaseNativeIDB=indexedDB;Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:{open(){throw new DOMException('Synthetic IndexedDB failure','SecurityError')}}})" });
    await failurePage.call("Page.navigate", { url: origin });
    let failureState = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const status = await failurePage.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
      failureState = status.result.value || "";
      if (failureState.includes("needs attention")) break;
      await pause(100);
    }
    assert.match(failureState, /needs attention/i, "IndexedDB startup failure did not show a recovery state");
    const errorState = await failurePage.call("Runtime.evaluate", { expression: "document.querySelector('[data-app] h1')?.textContent", returnByValue: true });
    assert.match(errorState.result.value, /Private storage needs attention/);
    await failurePage.call("Runtime.evaluate", { expression: "Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:window.__releaseNativeIDB});true", returnByValue: true });
    await pause(300);
    await failurePage.call("Runtime.evaluate", { expression: "document.querySelector('[data-app] button')?.click()", returnByValue: true });
    let recovered = "";
    for (let attempt = 0; attempt < 150; attempt++) {
      const status = await failurePage.call("Runtime.evaluate", { expression: "document.querySelector('[data-storage-message]')?.textContent", returnByValue: true });
      recovered = status.result.value || "";
      if (recovered.includes("ready")) break;
      await pause(100);
    }
    const failureRecoveryDetail = await failurePage.call("Runtime.evaluate", { expression: "({body:document.querySelector('[data-app]')?.innerText,indexedDBRestored:indexedDB===window.__releaseNativeIDB,button:document.querySelector('[data-app] button')?.textContent})", returnByValue: true });
    assert.match(recovered, /ready/i, `storage recovery retry did not reopen the unchanged synthetic database: ${JSON.stringify(failureRecoveryDetail.result.value)}`);
    const failureData = await failurePage.call("Runtime.evaluate", { expression: "[...document.querySelectorAll('.class-card h2')].some(x=>x.textContent==='Synthetic Release QA')", returnByValue: true });
    assert.equal(failureData.result.value, true, "storage recovery lost previously saved synthetic data");
    failurePage.close();
    await browser.call("Target.closeTarget", { targetId: failureTarget.targetId });

    const migrationOrigin = `http://localhost:${port}`;
    page.close();
    const migrationTarget = await browser.call("Target.createTarget", { url: `${migrationOrigin}/__release_test__` });
    targetId = migrationTarget.targetId;
    const migrationTargetDeadline = Date.now() + 5000;
    let migrationDebugTarget;
    while (Date.now() < migrationTargetDeadline) {
      migrationDebugTarget = (await (await fetch(`${cdpHttp}/json/list`)).json()).find((item) => item.id === targetId);
      if (migrationDebugTarget?.webSocketDebuggerUrl) break;
      await pause(50);
    }
    assert.ok(migrationDebugTarget?.webSocketDebuggerUrl, "Chromium did not expose the isolated migration page");
    page = cdp(migrationDebugTarget.webSocketDebuggerUrl);
    await page.ready;
    page.on("Runtime.exceptionThrown", (event) => consoleIssues.push(event.exceptionDetails?.text || "uncaught exception"));
    page.on("Log.entryAdded", (event) => { if (["error", "warning"].includes(event.entry.level)) consoleIssues.push(`${event.entry.level}: ${event.entry.text}`); });
    page.on("Network.requestWillBeSent", (event) => pageRequests.push({ url: event.request.url, method: event.request.method }));
    await Promise.all([page.call("Page.enable"), page.call("Runtime.enable"), page.call("Log.enable"), page.call("Network.enable")]);
    await waitFor("document.readyState==='complete'", "isolated v8 migration setup origin");
    await evaluate(`(()=>{window.__v8MigrationStage='loading-storage-module';import('./storage.js').then(({STORE_DEFINITIONS})=>{window.__v8MigrationStage='opening-v8';const request=indexedDB.open('teacher-workspace',8);request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains('meta'))db.createObjectStore('meta',{keyPath:'key'});for(const definition of STORE_DEFINITIONS.filter(({name})=>!['classWork','workSubmissions'].includes(name))){const store=db.createObjectStore(definition.name,{keyPath:'id'});for(const [indexName,keyPath] of definition.indexes)store.createIndex(indexName,keyPath,{unique:false})}request.transaction.objectStore('meta').put({key:'schemaVersion',value:8,updatedAt:new Date().toISOString()})};request.onerror=()=>window.__v8MigrationStage='error:'+request.error;request.onsuccess=()=>{const db=request.result,now=new Date().toISOString(),classId='v8-preserved-class',studentId='v8-preserved-student',assessmentId='v8-preserved-assessment',date='2026-09-30',classRecord={id:classId,className:'V8 Preserved Class',gradeLevel:'Grade 6',subject:'Science',term:'2026',schedule:'',notes:'',archivedAt:null,type:'class',createdAt:now,updatedAt:now},student={id:studentId,classId,fullName:'V8 Preserved Student',normalizedName:'v8 preserved student',archivedAt:null,type:'student',createdAt:now,updatedAt:now},assessment={id:assessmentId,classId,title:'V8 Preserved Check',date,classDate:classId+'::'+date,maximumScore:'10',category:'',term:'',policyId:'generic-raw-v1',instructions:'',assessmentKind:'quiz',authoringStatus:'draft',showPoints:false,type:'assessment',createdAt:now,updatedAt:now},tx=db.transaction(['classes','students','attendance','assessments','scores','lessons','materials'],'readwrite');tx.objectStore('classes').put(classRecord);tx.objectStore('students').put(student);tx.objectStore('attendance').put({id:'v8-preserved-attendance',classId,studentId,date,classDate:classId+'::'+date,status:'present',type:'attendance',createdAt:now,updatedAt:now});tx.objectStore('assessments').put(assessment);tx.objectStore('scores').put({id:'v8-preserved-score',assessmentId,classId,studentId,assessmentStudent:assessmentId+'::'+studentId,rawScore:'0',type:'score',createdAt:now,updatedAt:now});tx.objectStore('lessons').put({id:'v8-preserved-lesson',classId,title:'V8 Preserved Lesson',date,status:'draft',learningGoals:'',type:'lesson',createdAt:now,updatedAt:now});tx.objectStore('materials').put({id:'v8-preserved-material',kind:'lesson',title:'V8 Preserved Material',content:{title:'V8 Preserved Material',status:'draft',learningGoals:'',priorKnowledge:'',materials:'',before:'',during:'',checkForUnderstanding:'',assessment:'',reflection:'',nextStep:'',notes:''},type:'material',createdAt:now,updatedAt:now});tx.oncomplete=()=>{db.close();window.__v8Seed={classId,studentId,assessmentId};window.__v8MigrationStage='seeded'};tx.onerror=()=>window.__v8MigrationStage='error:'+tx.error;tx.onabort=()=>window.__v8MigrationStage='error:'+tx.error}}).catch(error=>window.__v8MigrationStage='error:'+error);return true})()`);
    await waitFor("window.__v8MigrationStage==='seeded'||String(window.__v8MigrationStage).startsWith('error:')", "synthetic v8 database seed");
    assert.equal(await evaluate("window.__v8MigrationStage"), "seeded");
    assert.deepEqual(await evaluate("window.__v8Seed"), { classId: "v8-preserved-class", studentId: "v8-preserved-student", assessmentId: "v8-preserved-assessment" });
    const migrationFaultScript = await page.call("Page.addScriptToEvaluateOnNewDocument", { source: "window.__originalCreateIndex=IDBObjectStore.prototype.createIndex;window.__migrationCreateIndexInjected=false;IDBObjectStore.prototype.createIndex=function(...args){if(!window.__migrationCreateIndexInjected&&this.name==='classWork'){window.__migrationCreateIndexInjected=true;throw new DOMException('Synthetic upgrade failure','UnknownError')}return window.__originalCreateIndex.apply(this,args)}" });
    await page.call("Page.navigate", { url: `${migrationOrigin}/` });
    await waitFor("document.querySelector('[data-storage-dot]')?.dataset.state==='error'", "recoverable v8-to-v9 upgrade failure", 15000);
    assert.match(await evaluate("document.querySelector('[data-app]')?.innerText||''"), /Private storage needs attention[\s\S]*could not be prepared/);
    await evaluate(`(()=>{window.__v8AfterAbortStage='opening';const request=indexedDB.open('teacher-workspace');request.onerror=()=>window.__v8AfterAbortStage='error:'+request.error;request.onsuccess=()=>{const db=request.result,tx=db.transaction(['classes','students','attendance','assessments','scores','lessons','materials'],'readonly'),names=Array.from(db.objectStoreNames),storeNames=['classes','students','attendance','assessments','scores','lessons','materials'],records={};for(const name of storeNames){const read=tx.objectStore(name).getAll();read.onsuccess=()=>records[name]=read.result}tx.oncomplete=()=>{window.__v8AfterAbort={version:db.version,names,className:records.classes[0]?.className,studentName:records.students[0]?.fullName,attendanceStatus:records.attendance[0]?.status,score:records.scores[0]?.rawScore,lessonTitle:records.lessons[0]?.title,materialTitle:records.materials[0]?.title};db.close();window.__v8AfterAbortStage='read'};tx.onerror=()=>window.__v8AfterAbortStage='error:'+tx.error;tx.onabort=()=>window.__v8AfterAbortStage='error:'+tx.error};return true})()`);
    await waitFor("window.__v8AfterAbortStage==='read'||String(window.__v8AfterAbortStage).startsWith('error:')", "read v8 database after aborted upgrade");
    assert.equal(await evaluate("window.__v8AfterAbortStage"), "read");
    const v8AfterAbort = await evaluate("window.__v8AfterAbort");
    assert.equal(v8AfterAbort.version, 8, "an aborted schema upgrade must leave the old database version intact");
    assert.equal(v8AfterAbort.names.includes("classWork"), false);
    assert.equal(v8AfterAbort.names.includes("workSubmissions"), false);
    assert.deepEqual(v8AfterAbort, { version: 8, names: v8AfterAbort.names, className: "V8 Preserved Class", studentName: "V8 Preserved Student", attendanceStatus: "present", score: "0", lessonTitle: "V8 Preserved Lesson", materialTitle: "V8 Preserved Material" });
    await evaluate("IDBObjectStore.prototype.createIndex=window.__originalCreateIndex;delete window.__originalCreateIndex;document.querySelector('[data-app] button')?.click();true");
    await page.call("Page.removeScriptToEvaluateOnNewDocument", { identifier: migrationFaultScript.identifier });
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "retry v8-to-v9 migration", 15000);
    const v9Preserved = await readStorage(`(async()=>{const health=await s.getLocalStoreHealth(),classRecord=await s.getRecord('classes','v8-preserved-class'),students=await s.listStudents('v8-preserved-class'),attendance=await s.listAttendanceRecords('v8-preserved-class'),assessments=await s.listAssessments('v8-preserved-class'),scores=await s.listScoresForClass('v8-preserved-class'),lessons=await s.listLessons('v8-preserved-class'),materials=await s.listMaterials(),classWork=await s.listClassWork('v8-preserved-class');return {health,className:classRecord?.className,students:students.map(x=>x.fullName),attendance:attendance.map(x=>x.status),assessments:assessments.map(x=>x.title),scores:scores.map(x=>x.rawScore),lessons:lessons.map(x=>x.title),materials:materials.map(x=>x.title),classWork:classWork.length}})()`);
    assert.equal(v9Preserved.health.databaseVersion, 9);
    assert.equal(v9Preserved.className, "V8 Preserved Class");
    assert.deepEqual(v9Preserved.students, ["V8 Preserved Student"]);
    assert.deepEqual(v9Preserved.attendance, ["present"]);
    assert.deepEqual(v9Preserved.assessments, ["V8 Preserved Check"]);
    assert.deepEqual(v9Preserved.scores, ["0"]);
    assert.deepEqual(v9Preserved.lessons, ["V8 Preserved Lesson"]);
    assert.deepEqual(v9Preserved.materials, ["V8 Preserved Material"]);
    assert.equal(v9Preserved.classWork, 0, "new stores must begin empty without altering legacy records");
    await page.call("Page.reload");
    await waitFor("document.querySelector('[data-storage-message]')?.textContent.includes('ready')", "reopen after v9 migration");
    assert.equal((await readStorage("s.getLocalStoreHealth()" )).databaseVersion, 9, "reopening must not rerun destructive or duplicate migrations");
    const restoreFailure = await readStorage(`(async()=>{const original=await s.createBackup(),replacement=structuredClone(original),className=original.data.classes[0]?.className,studentName=original.data.students[0]?.fullName;replacement.data.classes[0].className='Replacement Must Roll Back';replacement.data.students[0].fullName='Replacement Student Must Roll Back';const nativePut=IDBObjectStore.prototype.put;let injected=false;IDBObjectStore.prototype.put=function(...args){if(!injected&&this.name==='students'){injected=true;throw new DOMException('Synthetic replacement restore write failure','QuotaExceededError')}return nativePut.apply(this,args)};let rejected=false;try{await s.replaceWithBackup(replacement)}catch{rejected=true}finally{IDBObjectStore.prototype.put=nativePut}const classes=await s.listClasses(),students=await s.listStudents('v8-preserved-class');return {rejected,injected,className,studentName,remainingClasses:classes.map(item=>item.className),remainingStudents:students.map(item=>item.fullName)}})()`);
    assert.deepEqual(restoreFailure, { rejected: true, injected: true, className: "V8 Preserved Class", studentName: "V8 Preserved Student", remainingClasses: ["V8 Preserved Class"], remainingStudents: ["V8 Preserved Student"] }, "a failed native replacement transaction must leave the existing backup data intact");
    const assessmentDeleteFailure = await readStorage(`(async()=>{const before=await s.createBackup(),snapshot=JSON.stringify(before.data),nativeDelete=IDBObjectStore.prototype.delete;let injected=false;IDBObjectStore.prototype.delete=function(...args){if(!injected&&this.name==='scores'){injected=true;throw new DOMException('Synthetic assessment deletion failure','QuotaExceededError')}return nativeDelete.apply(this,args)};let rejected=false;try{await s.deleteAssessmentPermanently('v8-preserved-assessment')}catch{rejected=true}finally{IDBObjectStore.prototype.delete=nativeDelete}const after=await s.createBackup();return {injected,rejected,allRecordsUnchanged:snapshot===JSON.stringify(after.data),assessment:after.data.assessments.some(item=>item.id==='v8-preserved-assessment'),score:after.data.scores.some(item=>item.id==='v8-preserved-score')}})()`);
    assert.deepEqual(assessmentDeleteFailure, { injected: true, rejected: true, allRecordsUnchanged: true, assessment: true, score: true }, "a failed assessment deletion must roll back its records together");
    const classDeleteFailure = await readStorage(`(async()=>{const other=await s.saveClass({className:'Untouched Synthetic Class'}),otherStudent=await s.saveStudent({fullName:'Untouched Synthetic Student'},other.id),assessment=await s.saveAssessment({title:'Untouched assessment',date:'2026-09-30',maximumScore:'10'},other.id),work=await s.saveClassWork({title:'Untouched class work',dueDate:'2026-09-30',assessmentId:assessment.id},other.id);await s.saveScores(assessment.id,[{studentId:otherStudent.id,rawScore:'0'}]);await s.saveAttendance(other.id,'2026-09-30',[{studentId:otherStudent.id,status:'late'}]);await s.saveLesson({title:'Untouched lesson'},other.id);await s.saveWorkSubmissions(other.id,work.id,[{studentId:otherStudent.id,status:'submitted'}]);const targetWork=await s.saveClassWork({title:'Target class work'},'v8-preserved-class');await s.saveWorkSubmissions('v8-preserved-class',targetWork.id,[{studentId:'v8-preserved-student',status:'missing'}]);const before=await s.createBackup(),snapshot=JSON.stringify(before.data),nativeDelete=IDBObjectStore.prototype.delete;let injected=false;IDBObjectStore.prototype.delete=function(...args){if(!injected&&this.name==='workSubmissions'){injected=true;throw new DOMException('Synthetic permanent deletion failure','QuotaExceededError')}return nativeDelete.apply(this,args)};let rejected=false;try{await s.deleteClassPermanently('v8-preserved-class')}catch{rejected=true}finally{IDBObjectStore.prototype.delete=nativeDelete}const after=await s.createBackup();return {injected,rejected,allRecordsUnchanged:snapshot===JSON.stringify(after.data),targetClass:after.data.classes.some(item=>item.id==='v8-preserved-class'),targetWork:after.data.classWork.some(item=>item.id===targetWork.id),otherClass:after.data.classes.some(item=>item.id===other.id),otherWork:after.data.classWork.some(item=>item.id===work.id),otherStatus:after.data.workSubmissions.some(item=>item.workItemId===work.id&&item.studentId===otherStudent.id&&item.status==='submitted')}})()`);
    assert.deepEqual(classDeleteFailure, { injected: true, rejected: true, allRecordsUnchanged: true, targetClass: true, targetWork: true, otherClass: true, otherWork: true, otherStatus: true }, "a failed permanent class deletion must roll back every related store and preserve other classes");

    const externalRequests = pageRequests.filter(({ url }) => !url.startsWith(origin) && !url.startsWith(migrationOrigin) && !url.startsWith("blob:") && !url.startsWith("data:"));
    assert.deepEqual(externalRequests, [], `unexpected external requests: ${externalRequests.map((item) => item.url).join(", ")}`);
    assert.equal(pageRequests.some(({ url }) => /passphrase|Synthetic%20Student|Synthetic%20Release|8\.5/i.test(url)), false, "sensitive synthetic values appeared in a request URL");
    assert.deepEqual(consoleIssues, [], `browser console issues: ${consoleIssues.join(" | ")}; failed host paths: ${JSON.stringify(requests.filter((item) => item.status >= 400))}`);
    assert.equal(requests.some((item) => item.path === "/_headers"), false, "_headers must be consumed by the host, not served as an app asset");
  } finally {
    try { if (page) page.close(); } catch {}
    let chromeStopped = chrome?.exitCode !== null;
    if (browser && !chromeStopped) {
      try { await Promise.race([browser.call("Browser.close").then(() => true).catch(() => false), pause(3000).then(() => false)]); } catch {}
      if (chromeExited) chromeStopped = await Promise.race([chromeExited.then(() => true), pause(5000).then(() => false)]);
    }
    try { if (browser) browser.close(); } catch {}
    if (!chromeStopped) {
      try {
        if (chrome?.pid && process.platform === "win32") spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        else chrome?.kill();
      } catch { try { chrome?.kill(); } catch {} }
    }
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    if (chromeExited && !chromeStopped) await Promise.race([chromeExited, pause(5000)]);
    await pause(1000);
    let lastCleanupError = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { await rm(tempRoot, { recursive: true, force: true }); break; }
      catch (error) {
        if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error.code)) throw error;
        lastCleanupError = error;
        if (attempt === 39) { t.diagnostic(`Synthetic Chrome profile cleanup remained locked at ${lastCleanupError.path || tempRoot} (${lastCleanupError.code}) after Chromium shutdown.`); break; }
        await pause(500);
      }
    }
  }
});
