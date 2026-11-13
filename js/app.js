import * as Store from "./store.js";
import * as Cloud from "./cloud.js";
import { requireAuth, renameActiveWorkspace, getSignedInUser } from "./auth.js";

const $ = id => document.getElementById(id);
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const shortDays = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
let currentView = "today", taskFilter = "all", calendarMode = "day", selectedDays = new Set(), operations = [], customReminderOffsets = [], viewHistory = [];
let calendarDate = new Date(); calendarDate.setHours(12,0,0,0);
let calendarReturnToMonth = false;
let detailDateKey = keyDate();
let toastTimer;
let authenticatedWorkspace = null;
let signedInUser = null;

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  clearTimeout(toastTimer);
  el.classList.add("show");
  // Popovers enter the browser top layer, above modal dialogs and their backdrops.
  try { if (!el.matches(":popover-open")) el.showPopover(); } catch (_) { /* CSS fallback below */ }
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    try { if (el.matches(":popover-open")) el.hidePopover(); } catch (_) {}
  }, 4800);
}
function keyDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function dateLabel(d = new Date()) { return d.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"}); }
function parseTime(t) { if(!t)return null; const [h,m]=t.split(":").map(Number); return h*60+m; }
function statusFor(task, date = keyDate()) {
  const occ = task.occurrences?.[date];
  if (occ?.status === "completed") return "done";
  if (occ?.status === "progress") return "progress";
  const start = parseTime(task.start);
  const now = new Date();
  if (date < keyDate()) return "late";
  if (date === keyDate() && start !== null && now.getHours()*60+now.getMinutes() >= start) return "late";
  return "future";
}
function taskOccurs(task, date) {
  const d = new Date(date + "T12:00:00");
  if (task.repeat === "daily") return true;
  if (task.repeat === "weekdays") return (task.weekdays || []).includes(d.getDay());
  return task.date === date;
}
function todayTasks() {
  const date=keyDate();
  return Cloud.getState().tasks.filter(t=>taskOccurs(t,date)).sort((a,b)=>(parseTime(a.start)??9999)-(parseTime(b.start)??9999));
}
function person(id) { return Cloud.getState().people.find(p=>p.id===id); }
function personName(id) { return person(id)?.name || "Unassigned"; }
function personColor(id) { return person(id)?.color || "#6f8876"; }
function timeText(t) { if(!t)return "Anytime"; const [h,m]=t.split(":").map(Number); const d=new Date();d.setHours(h,m);return d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}); }
function empty(title,desc) { return `<div class="empty-state"><strong>${title}</strong>${desc}</div>`; }
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebarBackdrop").classList.remove("visible");
}
function openSidebar() {
  $("sidebar").classList.add("open");
  $("sidebarBackdrop").classList.add("visible");
}
function setView(view, fromBack=false) {
  if (view === currentView) return;
  if (!fromBack) viewHistory.push(currentView);
  currentView=view;
  document.querySelectorAll(".view").forEach(v=>v.classList.toggle("active",v.id===`view-${view}`));
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.classList.toggle("active",b.dataset.view===view));
  const pageTitles={today:"",calendar:"Calendar",tasks:"Tasks",meals:"Meals",groceries:"Groceries",people:"People",ledger:"Activity",settings:"Settings"}; $("pageTitle").textContent=pageTitles[view] ?? "Today";
  $("pageBack").hidden = view === "today";
  closeSidebar();
  render();
}
function goBack() { const previous=viewHistory.pop()||"today"; setView(previous,true); }

function askWIWYConfirm(title, message, acceptLabel="Confirm") {
  return new Promise(resolve => {
    const dialog=$("wiwyConfirmDialog");
    $("wiwyConfirmTitle").textContent=title;
    $("wiwyConfirmMessage").textContent=message;
    $("wiwyConfirmAccept").textContent=acceptLabel;
    const finish=value=>{dialog.close();$("wiwyConfirmAccept").removeEventListener("click",yes);$("wiwyConfirmCancel").removeEventListener("click",no);dialog.removeEventListener("cancel",cancel);resolve(value);};
    const yes=()=>finish(true), no=()=>finish(false), cancel=e=>{e.preventDefault();finish(false);};
    $("wiwyConfirmAccept").addEventListener("click",yes);
    $("wiwyConfirmCancel").addEventListener("click",no);
    dialog.addEventListener("cancel",cancel);
    dialog.showModal();
  });
}
async function openTaskDetails(task, date=keyDate()) {
  if(!task)return;
  detailDateKey=date;
  try { if(taskOccurs(task,date) && !task.occurrences?.[date]?.id) await Cloud.ensureOccurrence(task.id,date); } catch(error) { toast("Could not prepare task occurrence: "+error.message); }
  task=Cloud.getState().tasks.find(t=>t.id===task.id)||task;
  const occurrence=task.occurrences?.[date];
  const done=occurrence?.status==="completed";
  const names=(task.assigneeIds||[]).map(personName).join(", ")||"Unassigned";
  const canComplete=Cloud.canCompleteTask(task);
  const canEdit=Cloud.canManageTask(task);
  const operations=task.operations||[];
  const steps=operations.length
    ? `<section class="detail-section"><h3>Steps</h3><ul class="detail-steps">${operations.map(o=>`<li><label class="detail-step ${o.completedDates?.[date]?"step-done":""}"><input type="checkbox" data-detail-step-task="${task.id}" data-detail-step-date="${date}" data-detail-step-id="${o.id}" ${o.completedDates?.[date]?"checked":""} ${!canComplete||done?"disabled":""}><span>${esc(o.name)}</span></label></li>`).join("")}</ul></section>`
    : "";
  const status=done?"Completed":occurrence?.status==="progress"?"In progress":statusFor(task,date)==="late"?"Needs a start":"Scheduled";
  $("taskDetailTitle").textContent=task.name;
  $("taskDetailContent").innerHTML=`
    <section class="detail-section"><h3>Schedule</h3><p>${esc(dateLabel(new Date(date+"T12:00:00")))} · ${esc(timeText(task.start))}${task.end?" – "+esc(timeText(task.end)):""}</p></section>
    <section class="detail-section"><h3>Assigned to</h3><p>${esc(names)}</p></section>
    ${task.notes?`<section class="detail-section"><h3>Notes</h3><p class="detail-notes">${esc(task.notes)}</p></section>`:""}
    ${steps}
    <section class="detail-section"><h3>Status</h3><p id="taskDetailStatus">${status}${done&&occurrence?.completedByProfileId?" · Completed by "+esc(personName(occurrence.completedByProfileId)):""}</p></section>
    <div class="detail-actions">
      ${canEdit?`<button class="secondary-button" data-detail-edit="${task.id}">Edit task</button>`:""}
      ${done&&canEdit?`<button class="secondary-button" data-detail-reopen="${task.id}">Reopen task</button>`:!done&&canComplete?`<button class="primary-button" data-detail-complete="${task.id}">Mark task complete</button>`:""}
    </div>`;
  $("taskDetailDialog").dataset.taskId=task.id;
  $("taskDetailDialog").dataset.dateKey=date;
  $("taskDetailDialog").showModal();
}
async function completeTaskFromDetails(taskId) {
  const task=Cloud.getState().tasks.find(t=>t.id===taskId); if(!task)return;
  const date=detailDateKey;
  try {
    if(task.operations?.length>=2){
      if(!await askWIWYConfirm("Complete this task?","Are all steps for this task complete? Confirming will mark every step complete.","Complete task"))return;
      await Cloud.completeAllStepsAndTask(taskId,date);
    } else if(task.operations?.length===1) {
      await Cloud.completeAllStepsAndTask(taskId,date);
    } else {
      await Cloud.setOccurrence(taskId,date,"completed");
    }
    render(); await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskId),date); toast("✓ Task completed for everyone.");
  } catch(error){toast("Could not complete task: "+error.message);}
}

function renderToday() {
  const state={...Store.getState(), ...Cloud.getState()}, tasks=todayTasks();
  const done=tasks.filter(t=>statusFor(t)==="done").length, progress=tasks.filter(t=>statusFor(t)==="progress").length, late=tasks.filter(t=>statusFor(t)==="late").length;
  $("scheduledCount").textContent=tasks.length; $("completedCount").textContent=done; $("progressCount").textContent=progress; $("notStartedCount").textContent=late;
  $("dateLabel").innerHTML=`<span>${esc(new Date().toLocaleDateString(undefined,{weekday:"long"}))}</span><strong>${esc(new Date().toLocaleDateString(undefined,{month:"long",day:"numeric"}))}</strong>`; $("greeting").textContent=new Date().getHours()<12?"Good morning. Here's the shape of the day.":new Date().getHours()<17?"A clear plan for the rest of the day.":"Let's bring the day home.";
  $("todayAgenda").innerHTML=tasks.length?tasks.map(t=>`<button type="button" class="agenda-item agenda-task-button" data-agenda-task="${t.id}"><span class="agenda-time">${timeText(t.start)}</span><div class="agenda-stripe" style="--person-color:${personColor((t.assigneeIds||[])[0])}"></div><div><div class="agenda-name">${esc(t.name)}</div><div class="agenda-meta">${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}${t.end?" · until "+timeText(t.end):""}</div></div><span class="status-dot ${statusFor(t)}" title="${statusFor(t)}"></span></button>`).join(""):empty("Nothing scheduled yet","Create a task and it will appear here.");
  $("householdMini").innerHTML=state.people.filter(p=>p.active!==false).length?state.people.filter(p=>p.active!==false).map(p=>`<div class="person-mini"><span class="person-dot" style="--person-color:${p.color}"></span><span class="person-name">${esc(p.name)}</span><span class="person-count">${p.role}</span></div>`).join(""):empty("Add your household","Create member profiles to assign responsibilities.");
  const dinner=Cloud.getState().meals.find(m=>m.date===keyDate() && m.type==="dinner");
  $("dinnerPreview").innerHTML=dinner?`<div class="empty-icon">♨</div><div><strong>${esc(dinner.name)}</strong><div class="agenda-meta">${esc(dinner.notes||"Dinner plan")}</div></div>`:`<div class="empty-icon">♨</div><p>No dinner planned yet.</p>`;
}
function renderTasks() {
  const allTasks=Cloud.getState().tasks;
  const tasks=allTasks.filter(t=>{
    const status=statusFor(t);
    if(taskFilter==="scheduled") return !t.archived;
    if(taskFilter==="completed") return status==="done";
    if(taskFilter==="progress") return status==="progress";
    if(taskFilter==="late") return status==="late";
    if(taskFilter==="active") return !t.archived;
    if(taskFilter==="recurring") return t.repeat!=="once";
    return !t.archived;
  });
  $("taskList").innerHTML=tasks.length?tasks.map(t=>{
    const occ=t.occurrences?.[keyDate()], done=occ?.status==="completed";
    const names=(t.assigneeIds||[]).map(personName).join(", ")||"Unassigned";
    const canEdit=Cloud.canManageTask(t), canComplete=Cloud.canCompleteTask(t);
    const steps=(t.operations||[]).map(o=>`<label class="task-step ${o.completed?"step-done":""}"><input type="checkbox" data-step-task="${t.id}" data-step-id="${o.id}" ${o.completed?"checked":""} ${!canComplete||done?"disabled":""}><span>${esc(o.name)}</span></label>`).join("");
    const required=(t.operations||[]).filter(o=>o.required), allStepsDone=required.length>0&&required.every(o=>o.completed);
    return `<article class="task-card ${done?"task-card-done":""}"><div class="task-row"><button class="task-check ${done?"checked":""}" data-complete="${t.id}" ${!canComplete||done?"disabled":""} aria-label="Complete task">${done?"✓":""}</button><div class="task-main"><div class="task-title">${esc(t.name)}</div><div class="task-detail">${esc(names)} · ${repeatText(t)} · ${(t.operations||[]).length} steps${done?" · Completed"+(occ?.completedByProfileId?" by "+esc(personName(occ.completedByProfileId)):""):""}</div></div><div class="task-time">${timeText(t.start)}</div>${canEdit?`<button class="task-edit" data-edit-task="${t.id}" aria-label="Edit task">Edit</button>`:""}${done&&canEdit?`<button class="reopen-task" data-reopen-task="${t.id}">Reopen</button>`:""}</div>${steps?`<div class="task-steps">${steps}</div>${allStepsDone&&!done?`<p class="steps-hint">All required steps are complete. The task will finish automatically.</p>`:""}`:""}</article>`;
  }).join(""):empty("No tasks here yet","Add a task to begin building your household routine.");
}
function repeatText(t) { return t.repeat==="daily"?"Daily":t.repeat==="weekdays"?(t.weekdays||[]).map(x=>shortDays[x]).join(", "):"One time"; }
function renderMeals() {
  const meals=Cloud.getState().meals.slice().sort((a,b)=>a.date.localeCompare(b.date)||["breakfast","lunch","dinner"].indexOf(a.type)-["breakfast","lunch","dinner"].indexOf(b.type));
  const tasks=Cloud.getState().tasks;
  $("mealList").innerHTML=meals.length?meals.map(m=>{
    const date=new Date(m.date+"T12:00:00");
    const related=tasks.filter(t=>t.linkedMealId===m.id);
    return `<article class="meal-row meal-row-card"><div class="meal-day">${esc(date.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}))}<small>${esc(m.type)}</small></div><div><div class="meal-name">${esc(m.name)}</div><div class="meal-notes">${esc(m.notes||"")}</div>${related.length?`<div class="meal-linked-tasks">${related.map(t=>`<span>✓ ${esc(t.name)}${t.start?" · "+esc(timeText(t.start)):""}</span>`).join("")}</div>`:""}</div><div class="meal-actions"><button type="button" class="task-edit" data-edit-meal="${m.id}" aria-label="Edit meal">✎</button><button type="button" class="task-edit" data-delete-meal="${m.id}" aria-label="Delete meal">×</button></div></article>`;
  }).join(""):empty("Nothing on the menu yet.","Add a meal and, if needed, the prep tasks that go with it.");
}
function renderGroceries() {
  const items=Cloud.getState().groceries;
  $("groceryHeading").textContent=`Items to pick up · ${items.filter(i=>!i.done).length} remaining`;
  $("groceryList").innerHTML=items.length?items.map(i=>`<div class="grocery-row ${i.done?"done":""}"><input type="checkbox" data-grocery="${i.id}" ${i.done?"checked":""} aria-label="Mark ${esc(i.name)} purchased" style="width:17px;height:17px"><label><strong>${esc(i.name)}</strong><small>${esc(i.quantity||"")}${i.notes?" · "+esc(i.notes):""}</small></label><span class="grocery-category">${esc(i.category)}</span><button type="button" class="task-edit" data-edit-grocery="${i.id}" aria-label="Edit ${esc(i.name)}">✎</button><button type="button" class="task-edit" data-delete-grocery="${i.id}" aria-label="Remove ${esc(i.name)}">×</button></div>`).join(""):empty("Your list is clear.","Add groceries, ingredients, and household supplies.");
}
function renderPeople() {
  const people = Cloud.getState().people;
  const admin = Cloud.isAdmin();
  const manager = Cloud.getMembership()?.role === "Manager";
  const requests = Cloud.getRemovalRequests();
  $("addPersonButton").hidden = !Cloud.canManageProfiles();

  const requestPanel = admin && requests.length ? `
    <section class="panel member-requests">
      <div class="panel-heading"><h3>Removal requests</h3><span class="eyebrow">ADMIN REVIEW</span></div>
      ${requests.map(r => {
        const person = people.find(p => p.id === r.profile_id);
        const requested = r.requested_at ? new Date(r.requested_at).toLocaleDateString() : "";
        return `<div class="request-row">
          <span><strong>${esc(person?.name || "Household member")}</strong><small>Requested ${esc(requested)}</small></span>
          <button type="button" class="secondary-button" data-removal-decline="${r.id}">Decline</button>
          <button type="button" class="primary-button" data-removal-approve="${r.id}">Approve</button>
        </div>`;
      }).join("")}
    </section>` : "";

  const cards = people.length ? people.map(person => `
    <article class="person-card ${person.active ? "" : "person-inactive"}">
      <div class="person-avatar" style="background:${esc(person.color || "#789a80")}">${esc(person.name.slice(0,1).toUpperCase())}</div>
      <h3>${esc(person.name)}</h3>
      <p>${esc(person.role)} · ${person.accountId ? "Account linked" : "Member profile"} · ${person.active ? "Active" : "Inactive"}</p>
      <div class="person-actions">
        ${admin ? `<button type="button" class="secondary-button" data-profile-edit="${person.id}">Edit profile</button><button type="button" class="secondary-button" data-profile-toggle="${person.id}" data-next-active="${person.active ? "false" : "true"}">${person.active ? "Deactivate" : "Reactivate"}</button><button type="button" class="secondary-button danger-button" data-profile-delete="${person.id}">Permanently delete</button>${person.accountId ? `<label class="role-control">Account role<select data-member-role="${person.accountUserId}" data-current-role="${person.accountRole}"><option ${person.accountRole==="Admin"?"selected":""}>Admin</option><option ${person.accountRole==="Manager"?"selected":""}>Manager</option><option ${person.accountRole==="Member"?"selected":""}>Member</option></select></label><button type="button" class="secondary-button" data-profile-access="${person.id}">Remove household login access</button>` : `<button type="button" class="secondary-button" data-invite-profile="${person.id}">Invite / link account</button>`}` : ""}
        ${manager && person.active ? `<button type="button" class="secondary-button" data-profile-request="${person.id}">Request removal</button>` : ""}
      </div>
    </article>`).join("") : empty("Start with your people.", "Add member profiles now. Accounts and invitations can be linked later.");

  $("peopleGrid").innerHTML = requestPanel + cards;
  $("memberAdminPanel").hidden=!admin;
  $("memberAdminContent").innerHTML=admin
    ? `<p class="muted small-note">Invite someone to an existing household profile. They create or sign in to their own WIWY account using the invited email address. Their account joins this household rather than creating a separate workspace.</p><p class="muted tiny">Managers receive task-management and assignment permissions. Only Admins can invite accounts or change roles.</p>`
    : `<p class="muted">Only household Admins can manage account invitations and roles.</p>`;
}
function renderLedger() {
  const entries=Cloud.getActivity();
  $("ledgerList").innerHTML=entries.length?entries.map(e=>{
    const detail=e.detail||{};
    const summary=detail.task_name||detail.name||detail.step_name||"";
    return `<div class="ledger-row"><div class="ledger-symbol">↗</div><div class="ledger-text"><strong>${esc(e.action)}</strong>${summary?` · ${esc(summary)}`:""}<div class="ledger-time">${esc(e.actorName||"Household member")} · ${new Date(e.created_at).toLocaleString()}</div></div></div>`;
  }).join(""):empty("Your workspace starts here.","New changes and completed work will appear here as your household uses WIWY.");
}
function addDays(date,amount){const d=new Date(date);d.setDate(d.getDate()+amount);return d;}
function formatMonth(date){return date.toLocaleDateString(undefined,{month:"long",year:"numeric"});}

// WIWY 0.9.5 — recurring family and civic observances.
// Preferences are local to this device; the observances themselves are generated
// from dates and profile birth dates so they never become stale one-off events.
const OBSERVANCE_DEFAULTS = { federal:true, catholic:true, family:true, civic:true, items:{} };
function observancePrefs(){
  const cloud=Cloud.getHouseholdSettings()?.observance_preferences;
  return {...OBSERVANCE_DEFAULTS,...(cloud||{}),items:{...(cloud?.items||{})}};
}
function saveObservancePrefs(prefs){
  Cloud.saveHouseholdSettings({observance_preferences:prefs}).catch(error=>{console.error(error);toast("Calendar preferences could not be saved to the household cloud.");});
}
function customObservances(){return Cloud.getHouseholdSettings()?.custom_observances||[];}
async function saveCustomObservances(items){
  await Cloud.saveHouseholdSettings({custom_observances:items});
}
function nthWeekday(year,month,weekday,n){
  const first=new Date(year,month,1,12);
  return new Date(year,month,1+((weekday-first.getDay()+7)%7)+(n-1)*7,12);
}
function lastWeekday(year,month,weekday){
  const last=new Date(year,month+1,0,12);
  return new Date(year,month+1,0-((last.getDay()-weekday+7)%7),12);
}
function easterSunday(year){
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),
    g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,
    l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),
    month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
  return new Date(year,month-1,day,12);
}
function addCalendarDays(date,days){const d=new Date(date);d.setDate(d.getDate()+days);return d;}
function dateKey(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;}
function observedFederalDate(date){
  const d=new Date(date);
  if(d.getDay()===6)d.setDate(d.getDate()-1);
  else if(d.getDay()===0)d.setDate(d.getDate()+1);
  return d;
}
function observancesForYear(year){
  const out=[];
  const add=(id,title,date,category,reminder=false,notes="")=>out.push({id,title,date:dateKey(date),category,reminder,notes});
  const fixed=(month,day)=>new Date(year,month-1,day,12);
  // U.S. federal holidays (observed dates where applicable).
  [
    ["new-year","New Year's Day",fixed(1,1)],
    ["juneteenth","Juneteenth National Independence Day",fixed(6,19)],
    ["independence","Independence Day",fixed(7,4)],
    ["veterans","Veterans Day",fixed(11,11)],
    ["christmas-federal","Christmas Day",fixed(12,25)]
  ].forEach(([id,title,d])=>add(id,title,observedFederalDate(d),"federal"));
  add("mlk","Birthday of Martin Luther King, Jr.",nthWeekday(year,0,1,3),"federal");
  add("presidents","Washington's Birthday (Presidents Day)",nthWeekday(year,1,1,3),"federal");
  add("memorial","Memorial Day",lastWeekday(year,4,1),"federal");
  add("labor","Labor Day",nthWeekday(year,8,1,1),"federal");
  add("columbus","Columbus Day",nthWeekday(year,9,1,2),"federal");
  add("thanksgiving","Thanksgiving Day",nthWeekday(year,10,4,4),"federal");
  // Catholic solemnities and major liturgical days. Ascension and Corpus Christi
  // use the Sunday observance common in the United States.
  const easter=easterSunday(year);
  const catholic=[
    ["mary-mother-god","Mary, Mother of God",fixed(1,1)],
    ["epiphany","Epiphany of the Lord",(function(){const d=nthWeekday(year,0,0,1);return d.getDate()===1?addCalendarDays(d,7):d;})()],
    ["baptism","Baptism of the Lord",(function(){const e=nthWeekday(year,0,0,1);const ep=e.getDate()===1?addCalendarDays(e,7):e;return ep.getDate()>=7?addCalendarDays(ep,1):addCalendarDays(ep,7);})()],
    ["presentation","Presentation of the Lord",fixed(2,2)],
    ["ash-wednesday","Ash Wednesday",addCalendarDays(easter,-46)],
    ["st-joseph","Saint Joseph, Spouse of the Blessed Virgin Mary",fixed(3,19)],
    ["annunciation","Annunciation of the Lord",fixed(3,25)],
    ["palm-sunday","Palm Sunday",addCalendarDays(easter,-7)],
    ["holy-thursday","Holy Thursday",addCalendarDays(easter,-3)],
    ["good-friday","Good Friday",addCalendarDays(easter,-2)],
    ["easter","Easter Sunday",easter],
    ["ascension","Ascension of the Lord",addCalendarDays(easter,42)],
    ["pentecost","Pentecost Sunday",addCalendarDays(easter,49)],
    ["trinity","Trinity Sunday",addCalendarDays(easter,56)],
    ["corpus-christi","The Most Holy Body and Blood of Christ (Corpus Christi)",addCalendarDays(easter,63)],
    ["sacred-heart","Most Sacred Heart of Jesus",addCalendarDays(easter,68)],
    ["assumption","Assumption of the Blessed Virgin Mary",fixed(8,15)],
    ["all-saints","All Saints",fixed(11,1)],
    ["all-souls","Commemoration of All the Faithful Departed",fixed(11,2)],
    ["christ-king","Our Lord Jesus Christ, King of the Universe",fixed(11,22)]
  ];
  // Christ the King is the final Sunday of the liturgical year: Sunday before Advent.
  const advent1=new Date(year,10,27,12);
  while(advent1.getDay()!==0)advent1.setDate(advent1.getDate()+1);
  const christKing=addCalendarDays(advent1,-7);
  catholic[catholic.length-1][2]=christKing;
  catholic.push(
    ["immaculate-conception","Immaculate Conception",fixed(12,8)],
    ["our-lady-guadalupe","Our Lady of Guadalupe",fixed(12,12)],
    ["christmas-catholic","Nativity of the Lord (Christmas)",fixed(12,25)]
  );
  catholic.forEach(([id,title,d])=>add(id,title,d,"catholic"));
  // Family observances: all birthdays and the annual family dates.
  const people=Cloud.getState().people||[];
  people.forEach(p=>{
    const birth=p.birthDate||p.birth_date;
    if(!birth)return;
    const [,mm,dd]=birth.split("-").map(Number);
    const d=fixed(mm,dd);
    add(`birthday-${p.id}`,`${p.name}'s birthday`,d,"family",true,"Birthday reminder");
  });
  add("anniversary","Wedding anniversary",fixed(8,4),"family",true,"Anniversary reminder");
  add("mothers-day","Mother's Day",nthWeekday(year,4,0,2),"family",true,"Mother's Day reminder");
  add("fathers-day","Father's Day",nthWeekday(year,5,0,3),"family",false);
  // Common civic observances, displayed without advance alerts.
  add("valentines","Valentine's Day",fixed(2,14),"civic",true,"Valentine's Day reminder");
  add("st-patricks","St. Patrick's Day",fixed(3,17),"civic");
  add("halloween","Halloween",fixed(10,31),"civic");
  customObservances().forEach(o=>{if(o.annual){const [m,d]=o.date.slice(5).split("-").map(Number);add(o.id,o.title,fixed(m,d),o.category||"custom",false,"Custom annual observance");}else if(Number(o.date.slice(0,4))===year){add(o.id,o.title,new Date(o.date+"T12:00:00"),o.category||"custom",false,"Custom one-time observance");}});
  return out.sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
}
function observancesForDate(date){
  const prefs=observancePrefs(), key=dateKey(date);
  return observancesForYear(date.getFullYear()).filter(o=>
    prefs[o.category]!==false && prefs.items[o.id]!==false && o.date===key
  );
}
function renderObservanceSettings(){
  const prefs=observancePrefs(), categories=[
    ["federal","U.S. federal holidays"],["catholic","Catholic Christian calendar"],
    ["family","Family dates (birthdays, anniversary, Mother's/Father's Day)"],["civic","Other common civic observances"]
  ];
  const year=new Date().getFullYear();
  const items=observancesForYear(year);
  $("observanceSettings").innerHTML=categories.map(([key,label])=>
    `<label class="observance-toggle"><input type="checkbox" data-observance-category="${key}" ${prefs[key]!==false?"checked":""}><span>${label}</span></label>`
  ).join("")+`<details class="observance-individual"><summary>Choose individual observances</summary><div class="observance-individual-list">${
    items.map(o=>`<label><input type="checkbox" data-observance-item="${o.id}" ${prefs.items[o.id]!==false?"checked":""}><span>${esc(o.title)}</span></label>`).join("")
  }</div></details><div class="custom-observance-editor">
    <h4>Custom observances</h4>
    <div class="custom-observance-form">
      <input id="customObservanceTitle" type="text" placeholder="Observance name" maxlength="80">
      <input id="customObservanceDate" type="date">
      <label><input id="customObservanceAnnual" type="checkbox"> Repeat annually</label>
      <button type="button" class="secondary-button" id="addCustomObservance">Add observance</button>
    </div>
    <div class="custom-observance-list">${customObservances().map(o=>`<div class="custom-observance-row"><span>${esc(o.title)} · ${esc(o.date)}${o.annual?" · annual":""}</span><button type="button" class="text-button danger-button" data-delete-observance="${esc(o.id)}">Remove</button></div>`).join("")||'<p class="muted tiny">No custom observances added.</p>'}</div>
  </div><div class="custom-observance-editor"><h4>Family reminder rules</h4><p class="muted tiny">Advance notices are generated centrally and sent through WIWY push notifications. Leave recipients empty to notify every linked household account.</p>${(Cloud.getHouseholdSettings().reminder_rules||[]).map(r=>{const label=({birthday:"Birthdays",anniversary:"Wedding anniversary",mothers_day:"Mother's Day",valentines_day:"Valentine's Day",custom:"Custom observance"})[r.event_type]||r.event_key;return `<div class="custom-observance-row reminder-rule-row"><div><strong>${esc(label)}</strong><small>${esc(r.event_key)}</small></div><label>Days before <input type="text" inputmode="numeric" data-rule-days="${esc(r.id)}" value="${(r.offsets_minutes||[]).map(n=>Math.round(n/1440)).join(", ")}" aria-label="Reminder days before"></label><label>Notification note <input type="text" data-rule-note="${esc(r.id)}" value="${esc(r.note||"")}" maxlength="120"></label><label>Recipients <select multiple data-rule-recipients="${esc(r.id)}" aria-label="Reminder recipients">${(Cloud.getState().people||[]).map(person=>`<option value="${esc(person.id)}" ${(r.recipient_profile_ids||[]).includes(person.id)?"selected":""}>${esc(person.name)}</option>`).join("")}</select><small>None selected = all linked household members</small></label><div class="button-row"><button type="button" class="secondary-button" data-save-rule="${esc(r.id)}">Save rule</button><button type="button" class="text-button danger-button" data-delete-rule="${esc(r.id)}">Delete rule</button></div></div>`;}).join("")||'<p class="muted tiny">No reminder rules configured.</p>'}</div><p class="muted tiny">Birthday entries are generated from each member's saved birth date. Advance alerts are delivered by the household reminder service.</p>`;
}
function checkPersonalDateAlerts(){ /* Family-date alerts are generated server-side and delivered through the existing push dispatcher. */ }

function tasksForDate(date){
  const key=keyDate(date);
  return Cloud.getState().tasks.filter(t=>!t.archived&&taskOccurs(t,key)).sort((x,y)=>(parseTime(x.start)??9999)-(parseTime(y.start)??9999));
}
function renderCalendar(){
  const key=keyDate(calendarDate);
  document.querySelectorAll("[data-cal-mode]").forEach(b=>b.classList.toggle("selected",b.dataset.calMode===calendarMode));
  $("calendarReturnMonth").hidden=!(calendarMode==="day"&&calendarReturnToMonth);
  if(calendarMode==="month"){
    $("calendarDate").textContent=formatMonth(calendarDate);
    $("calendarGrid").className="calendar-grid month-grid";
    const first=new Date(calendarDate.getFullYear(),calendarDate.getMonth(),1,12), offset=first.getDay(), daysInMonth=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
    const cells=[];
    for(let i=0;i<offset;i++)cells.push(`<div class="month-empty"></div>`);
    for(let n=1;n<=daysInMonth;n++){
      const d=new Date(first.getFullYear(),first.getMonth(),n,12), k=keyDate(d), tasks=tasksForDate(d), obs=observancesForDate(d), isToday=k===keyDate(), selected=k===key;
      const dots=tasks.slice(0,4).map(t=>`<i style="--person-color:${personColor(t.assigneeIds?.[0])}"></i>`).join("")+(obs.length?'<i class="observance-dot"></i>':"");
      const label=obs.length?`<em class="month-observance-label">${esc(obs[0].title)}${obs.length>1?` +${obs.length-1}`:""}</em>`:"";
      cells.push(`<button class="month-day ${isToday?"is-today":""} ${selected?"is-selected":""}" data-month-date="${k}"><span>${n}</span><small>${tasks.length?tasks.length+" task"+(tasks.length===1?"":"s"):""}${obs.length?`${tasks.length?" · ":""}${obs.length} date${obs.length===1?"":"s"}`:""}</small><div class="month-dots">${dots}</div>${label}</button>`);
    }
    $("calendarGrid").innerHTML=`${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>`<div class="month-weekday">${d}</div>`).join("")}${cells.join("")}`;
    return;
  }
  if(calendarMode==="week"){
    const start=addDays(calendarDate,-calendarDate.getDay()), days=Array.from({length:7},(_,i)=>addDays(start,i));
    $("calendarDate").textContent=`${days[0].toLocaleDateString(undefined,{month:"short",day:"numeric"})} – ${days[6].toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}`;
    $("calendarGrid").className="calendar-grid week-grid";
    $("calendarGrid").innerHTML=days.map(d=>{
      const k=keyDate(d), tasks=tasksForDate(d), obs=observancesForDate(d);
      return `<section class="week-day ${k===keyDate()?"is-today":""}"><button class="week-day-head" data-month-date="${k}"><strong>${shortDays[d.getDay()]}</strong><span>${d.getDate()}</span></button><div class="week-day-tasks">${obs.map(o=>`<div class="calendar-observance ${o.category}"><strong>${esc(o.title)}</strong><small>${esc(o.category==="family"?"Family date":o.category==="catholic"?"Catholic observance":o.category==="federal"?"Federal holiday":"Observance")}</small></div>`).join("")}${tasks.length?tasks.map(t=>`<button class="week-task" data-calendar-task="${t.id}" data-task-date="${k}" style="--person-color:${personColor(t.assigneeIds?.[0])}"><strong>${esc(t.name)}</strong><small>${timeText(t.start)}</small></button>`).join(""):(!obs.length?`<span class="week-no-tasks">—</span>`:"")}</div></section>`;
    }).join("");
    return;
  }
  $("calendarDate").textContent=dateLabel(calendarDate);
  $("calendarGrid").className="calendar-grid day-grid";
  const tasks=tasksForDate(calendarDate), obs=observancesForDate(calendarDate);
  let html=obs.length?`<section class="day-observances">${obs.map(o=>`<div class="calendar-observance ${o.category}"><strong>${esc(o.title)}</strong><small>${esc(o.notes||({federal:"U.S. federal holiday",catholic:"Catholic observance",family:"Family date",civic:"Observance"}[o.category]))}</small></div>`).join("")}</section>`:"";
  for(let h=6;h<23;h++){
    const label=new Date(2000,0,1,h).toLocaleTimeString([],{hour:"numeric"});
    const items=tasks.filter(t=>Math.floor((parseTime(t.start)??9*60)/60)===h);
    html+=`<div class="time-label">${label}</div><div class="time-slot" data-hour="${h}">${items.map(t=>`<button type="button" class="calendar-event calendar-event-button" data-calendar-task="${t.id}" data-task-date="${key}" style="--person-color:${personColor(t.assigneeIds?.[0])}"><strong>${esc(t.name)}</strong><small>${timeText(t.start)}${t.end?" – "+timeText(t.end):""} · ${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}</small></button>`).join("")}</div>`;
  }
  $("calendarGrid").innerHTML=html;
}
function render() {
  const visibleWorkspaceName = authenticatedWorkspace?.name || Store.getState().workspace.name;
  const aboutVersion = document.getElementById("aboutVersion"); if (aboutVersion) aboutVersion.textContent = `WIWY · Version ${WIWY_VERSION} · Champagne logo and company attribution`;
  $("workspaceName").textContent = visibleWorkspaceName;
  $("settingsWorkspace").value = visibleWorkspaceName;
  const preserveObservanceDraft=$("observanceSettings").contains(document.activeElement);
  renderToday();renderTasks();renderMeals();renderGroceries();renderPeople();renderLedger();renderCalendar();if(!preserveObservanceDraft)renderObservanceSettings();
  const away=Cloud.getAwayPeriods();
  $("awayButton").innerHTML=away.length?`<img src="./icons/away-suitcase.svg" alt="" class="away-suitcase-icon"> <span class="desktop-only">Away mode on</span>`:`<img src="./icons/away-suitcase.svg" alt="" class="away-suitcase-icon"> <span class="desktop-only">Away mode</span>`;
  const unreadNotifications=Cloud.getNotifications().filter(n=>!n.read_at).length;
  $("notificationButton").classList.toggle("has-unread",unreadNotifications>0);
  $("notificationButton").setAttribute("aria-label",unreadNotifications?`Notifications, ${unreadNotifications} unread`:"Notifications");
  $("awayButton").disabled=!Cloud.canManageAway();
  const people=Cloud.getState().people;
  $("awayStatus").innerHTML=away.length
    ? `<div class="away-status-heading">Currently away</div>`+away.map(p=>{
        const person=people.find(x=>x.id===p.member_profile_id);
        const target=person?person.name:"Entire household";
        const until=p.ends_at?"Until "+new Date(p.ends_at).toLocaleString():"Until manually turned off";
        return `<div class="away-period-row"><div class="away-period-copy"><strong>${esc(target)}</strong><span>${esc(until)}</span></div><button type="button" class="secondary-button away-cancel-button" data-away-period="${esc(p.id)}">Turn off</button></div>`;
      }).join("")
    : "Away Mode is currently off.";
}

// WIWY 0.9.6 — user-controlled application updates.
const WIWY_VERSION="0.10.8";
let wiwyRegistration=null;
let updateInstallInProgress=false;
function showUpdateBanner(version,notes=""){
  const banner=$("updateBanner");if(!banner)return;
  banner.hidden=false;
  $("updateBannerText").textContent=`Version ${version} is ready to review.${notes?" "+notes:""}`;
}
function hideUpdateBanner(){const b=$("updateBanner");if(b)b.hidden=true;}
async function checkForWIWYUpdate(manual=false){
  const status=$("updateStatus");
  if(status)status.textContent="Checking for updates…";
  try{
    if(!navigator.onLine)throw new Error("Connect to the internet before checking for updates.");
    const response=await fetch("./wiwy-release.json",{cache:"no-store"});
    if(!response.ok)throw new Error("The release information could not be reached.");
    const release=await response.json();
    $("installedVersion").textContent=`Installed version: ${WIWY_VERSION}`;
    const newer=compareVersions(release.version,WIWY_VERSION)>0;
    $("availableVersion").textContent=newer?`Available version: ${release.version}`:`Latest version: ${release.version||WIWY_VERSION}`;
    if(newer)showUpdateBanner(release.version,release.notes||"");
    if(!wiwyRegistration)wiwyRegistration=await navigator.serviceWorker.register("./service-worker.js",{updateViaCache:"none"});
    await wiwyRegistration.update();
    if(wiwyRegistration.waiting){
      $("installUpdateButton").hidden=false;
      if(status)status.textContent=`Version ${release.version} is downloaded and waiting for your approval.`;
    }else if(newer && wiwyRegistration.installing){
      if(status)status.textContent="The update is downloading. Keep WIWY open briefly; the Install update button will appear when the files are ready.";
    }else if(newer){
      if(status)status.textContent="A newer release is published, but the browser has not installed its service worker yet. Check again shortly; your current household data is untouched.";
    }else if(status)status.textContent="WIWY is up to date.";
    if(!newer&&!wiwyRegistration.waiting)hideUpdateBanner();
  }catch(error){if(status)status.textContent=error.message;if(manual)toast("Update check: "+error.message);}
}
function compareVersions(a,b){
  const aa=String(a||"0").split(".").map(Number),bb=String(b||"0").split(".").map(Number);
  for(let i=0;i<Math.max(aa.length,bb.length);i++){const x=aa[i]||0,y=bb[i]||0;if(x!==y)return x-y;}return 0;
}
async function installWIWYUpdate(){
  if(updateInstallInProgress)return;
  if(document.querySelector("dialog[open]")){
    $("updateStatus").textContent="Close or save the open editor before installing. Your unsaved form is being left untouched.";
    return;
  }
  const focused=document.activeElement;
  if(focused && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName) && focused.type!=="file" && focused.value!==focused.defaultValue){
    $("updateStatus").textContent="Finish or save the field you are editing before installing the update.";
    return;
  }
  const worker=wiwyRegistration?.waiting;
  if(!worker){$("updateStatus").textContent="The update is not downloaded yet. Select Check for Updates again in a moment.";return;}
  if(!navigator.onLine){$("updateStatus").textContent="Connect to the internet before installing an update.";return;}
  updateInstallInProgress=true;
  const button=$("installUpdateButton");button.disabled=true;button.textContent="Preparing…";
  try{
    // WIWY writes directly to Supabase; it has no offline write queue. Refresh verifies
    // the signed-in cloud connection before allowing the application shell to change.
    await Cloud.prepareForUpdate();
    if(!await askWIWYConfirm("Install WIWY update?","Your household data is stored in Supabase. WIWY has verified the live connection. The app will reload to finish installing the update.","Install update"))return;
    $("updateStatus").textContent="Installing update…";
    const controllerChange=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error("The new version did not take control. The previous app remains available; reload and try again.")),20000);
      navigator.serviceWorker.addEventListener("controllerchange",()=>{clearTimeout(timeout);resolve();},{once:true});
    });
    worker.postMessage({type:"SKIP_WAITING"});
    await controllerChange;
    location.reload();
  }catch(error){$("updateStatus").textContent=error.message;toast("Update not installed: "+error.message);}
  finally{updateInstallInProgress=false;button.disabled=false;button.textContent="Install update";}
}
function setupWIWYUpdates(){
  if(!("serviceWorker" in navigator))return;
  navigator.serviceWorker.register("./service-worker.js",{updateViaCache:"none"}).then(reg=>{
    wiwyRegistration=reg;
    const ready=()=>{if(reg.waiting){$("installUpdateButton").hidden=false;showUpdateBanner("new version");}};
    ready();
    reg.addEventListener("updatefound",()=>{
      const installing=reg.installing;
      if(!installing)return;
      installing.addEventListener("statechange",()=>{
        if(installing.state==="installed"&&navigator.serviceWorker.controller){
          $("installUpdateButton").hidden=false;
          showUpdateBanner("new version");
          $("updateStatus").textContent="Update downloaded. It will not install until you choose Install update.";
        }
      });
    });
    navigator.serviceWorker.addEventListener("controllerchange",()=>{});
    $("reviewUpdateButton").onclick=()=>{setView("settings");$("updateSettingsCard")?.scrollIntoView({behavior:"smooth",block:"center"});};
    $("checkForUpdates").onclick=()=>checkForWIWYUpdate(true);
    $("installUpdateButton").onclick=installWIWYUpdate;
    checkForWIWYUpdate(false);
    window.setInterval(()=>checkForWIWYUpdate(false),6*60*60*1000);
  }).catch(error=>console.warn("WIWY update manager:",error));
}

const WIWY_VAPID_PUBLIC_KEY = "BAbz1r7e2cel3EAcDrGCIgjn3JLxbH28Qu3FiM366-L58-dzLBeVSHw7YDfh1xEzpJLBLx0SaiwRJXAyKOdEEcU";
function pushBase64ToBytes(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(ch => ch.charCodeAt(0)));
}
async function waitForPushServiceWorker() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support service workers.');
  const registration = await navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'none' });
  // Force a check for the repaired worker, then wait for activation with a useful timeout.
  try { await registration.update(); } catch (error) { console.warn('WIWY service-worker update check:', error); }
  if (registration.active) return registration;
  await new Promise((resolve, reject) => {
    const worker = registration.installing || registration.waiting;
    if (!worker) { reject(new Error('The WIWY service worker did not start installing. Refresh the page and try again.')); return; }
    const timeout = setTimeout(() => reject(new Error('The WIWY service worker did not activate within 15 seconds. Refresh the page once, then try again.')), 15000);
    const check = () => {
      if (worker.state === 'activated' || registration.active) { clearTimeout(timeout); resolve(); }
      else if (worker.state === 'redundant') { clearTimeout(timeout); reject(new Error('The WIWY service worker installation failed. Check that the latest app files were uploaded, then refresh.')); }
    };
    worker.addEventListener('statechange', check);
    check();
  });
  return registration;
}
async function enablePushNotifications() {
  const button = $('enablePushButton');
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('Push notifications are not supported by this browser. In-app notifications will still work.');
    return;
  }
  button.disabled = true;
  button.textContent = 'Enabling…';
  let enabled = false;
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (permission !== 'granted') {
      toast(permission === 'denied' ? 'Notifications are blocked in browser settings. In-app notifications remain available.' : 'Notifications were not enabled. You can try again here later.');
      return;
    }
    const registration = await waitForPushServiceWorker();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: pushBase64ToBytes(WIWY_VAPID_PUBLIC_KEY)
    });
    const authClient = window.WIWY_AUTH?.client;
    if (!authClient) throw new Error('WIWY could not access your signed-in account. Sign out and back in, then try again.');
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user?.id) throw new Error('Your WIWY account session could not be verified. Please sign in again.');
    const payload = subscription.toJSON();
    const { error } = await authClient.from('push_subscriptions').upsert({
      user_id: userData.user.id, endpoint: subscription.endpoint, subscription: payload,
      user_agent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      updated_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
    if (error) throw new Error('The device subscription was created, but Supabase could not save it: ' + error.message);
    enabled = true;
    button.textContent = 'Push notifications enabled';
    toast('This device is registered for WIWY push notifications.');
  } catch (error) {
    console.error('WIWY push registration:', error);
    toast('Could not enable push notifications: ' + (error?.message || 'Unknown error'));
  } finally {
    button.disabled = false;
    if (!enabled) button.textContent = Notification.permission === 'granted' ? 'Try enabling push again' : 'Enable push on this device';
  }
}



async function restorePushRegistrationState(){
  const button=$("enablePushButton");if(!button||!("Notification" in window)||Notification.permission!=="granted"||!("serviceWorker" in navigator))return;
  try{const reg=await navigator.serviceWorker.getRegistration("./");const sub=await reg?.pushManager?.getSubscription();if(!sub)return;const authClient=window.WIWY_AUTH?.client;if(!authClient)return;const {data,error}=await authClient.from("push_subscriptions").select("endpoint").eq("endpoint",sub.endpoint).maybeSingle();if(error)throw error;if(data){button.textContent="Push notifications enabled";button.disabled=false;}else{button.textContent="Finish push registration";button.disabled=false;}}catch(error){console.warn("WIWY push status check:",error);button.textContent="Check push registration";button.disabled=false;}
}

// Capture push-button taps at the document level rather than relying on a
// direct onclick property. This listener is installed before authenticated
// startup, so unrelated setup/rendering code cannot prevent the button binding.
document.addEventListener("click", event => {
  const button = event.target.closest("#enablePushButton");
  if (!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  button.textContent = "Starting push setup…";
  button.disabled = true;
  // The registration function owns subsequent progress, errors, and re-enabling.
  enablePushNotifications();
}, true);

function esc(s="") { return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function populatePeopleSelects() {
  const people=Cloud.getState().people.filter(p => p.active !== false);
  $("taskAssigneeOptions").innerHTML=people.length?people.map(p=>`<label class="assignee-option"><input type="checkbox" value="${p.id}" data-assignee-option> <span>${esc(p.name)}</span></label>`).join(""):empty("No household profiles yet","An Admin or authorized Manager can add people first.");
  $("awayPerson").innerHTML=`<option value="">Select a person</option>`+people.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join("");
}

function reminderOffsetLabel(minutes) {
  if (minutes % 1440 === 0) return `${minutes/1440} day${minutes/1440===1?"":"s"} before`;
  if (minutes % 60 === 0) return `${minutes/60} hour${minutes/60===1?"":"s"} before`;
  return `${minutes} minutes before`;
}
function selectedReminderOffsets() {
  const presets=[...document.querySelectorAll("[data-reminder-offset]:checked")].map(x=>Number(x.dataset.reminderOffset));
  return [...new Set([...presets,...customReminderOffsets])].sort((a,b)=>b-a);
}
function renderCustomReminderOffsets() {
  $("selectedCustomReminders").innerHTML=customReminderOffsets.map(v=>`<span class="selected-reminder">${esc(reminderOffsetLabel(v))}<button type="button" data-remove-reminder="${v}" aria-label="Remove reminder">×</button></span>`).join("");
}
function notificationTaskDate(task) {
  const now=new Date();
  if(task.repeat==="once") return task.date || keyDate();
  for(let i=0;i<60;i++){const d=addDays(now,i), key=keyDate(d);if(task.repeat==="daily" || (task.repeat==="weekdays" && (task.weekdays||[]).includes(d.getDay())))return key;}
  return keyDate();
}
function notificationTaskWhen(task, offset=0) {
  const date=notificationTaskDate(task);
  if(!task.start)return `${date} · No start time set`;
  const [h,m]=task.start.split(":").map(Number);
  const dt=new Date(`${date}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  dt.setMinutes(dt.getMinutes()-offset);
  return dt.toLocaleString([], {weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}
function renderNotificationCenter() {
  const profile=Cloud.getMembership()?.member_profile_id;
  const cutoff=Date.now()-24*60*60*1000;
  const records=Cloud.getNotifications().filter(n=>new Date(n.created_at).getTime()>=cutoff&&!n.dismissed_at);
  const groups=[
    ["Household assignments",records.filter(n=>["assignment","task_assignment","household","household_change"].includes(n.notification_type))],
    ["Task reminders",records.filter(n=>["reminder","task_reminder","advance_reminder","scheduled_start","observance_reminder"].includes(n.notification_type))],
    ["Task completions",records.filter(n=>["completion","task_completion"].includes(n.notification_type))]
  ];
  const row=n=>`<article class="notification-row ${n.read_at?"":"unread"}" data-notification-open="${esc(n.id)}" data-notification-task="${esc(n.task_id||"")}" data-notification-date="${esc(n.occurrence_date||"")}" role="button" tabindex="0"><div class="notification-row-copy"><strong>${esc(n.title)}</strong><span>${esc(n.body)}</span><small>${new Date(n.created_at).toLocaleString()}</small></div><div class="notification-row-actions"><button type="button" class="text-button" data-notification-read="${esc(n.id)}">${n.read_at?"Read":"Mark read"}</button><button type="button" class="text-button danger-button" data-notification-dismiss="${esc(n.id)}">Dismiss</button></div></article>`;
  const section=([name,items])=>`<section class="notification-section"><div class="notification-section-head"><h3>${name}</h3><span>${items.length}</span></div>${items.length?items.map(row).join(""):`<p class="notification-empty">Nothing here in the last 24 hours.</p>`}</section>`;
  $("notificationCenterContent").innerHTML=groups.map(section).join("");
}

function taskEditorSnapshot() {
  return JSON.stringify({
    name:$("taskName").value.trim(),
    assignees:[...document.querySelectorAll("[data-assignee-option]:checked")].map(o=>o.value).sort(),
    repeat:$("taskRepeat").value,
    weekdays:[...selectedDays].sort((x,y)=>x-y),
    start:$("taskStart").value,
    end:$("taskEnd").value,
    notes:$("taskNotes").value.trim(),
    reminderOffsets:selectedReminderOffsets(), completionPushEnabled:$("completionPushEnabled").checked,
    operations:operations.map(o=>({name:o.name,required:o.required!==false}))
  });
}
function taskEditorHasChanges() {
  return taskEditorSnapshot() !== ($("taskEditor").dataset.initialSnapshot || taskEditorSnapshot());
}
function openTask(task=null, initialDate=null) {
  populatePeopleSelects(); $("taskEditor").reset(); operations=[]; selectedDays=new Set(); customReminderOffsets=[];
  $("taskId").value=task?.id||""; $("taskDialogTitle").textContent=task?"Edit task":"Create a task";
  $("taskFormError").hidden=true; $("taskFormError").textContent="";
  $("taskName").value=task?.name||""; 
  const assigned=new Set(task?.assigneeIds||[]);
  if(!task && !Cloud.canAssignAnyone() && Cloud.getMembership()?.member_profile_id) assigned.add(Cloud.getMembership().member_profile_id);
  document.querySelectorAll("[data-assignee-option]").forEach(o=>{o.checked=assigned.has(o.value);o.disabled=!Cloud.canAssignAnyone();});
  $("taskRepeat").value=task?.repeat||"once";
  if(!task && initialDate) { window.wiwyTaskDraftDate=initialDate; } else { window.wiwyTaskDraftDate=null; }
  $("taskStart").value=task?.start||""; $("taskEnd").value=task?.end||""; $("taskNotes").value=task?.notes||"";
  const savedOffsets=task?.advanceReminderOffsets||[];
  document.querySelectorAll("[data-reminder-offset]").forEach(x=>x.checked=savedOffsets.includes(Number(x.dataset.reminderOffset)));
  customReminderOffsets=savedOffsets.filter(x=>![5,15,30,60].includes(x));
  $("completionPushEnabled").checked=!!task?.completionPushEnabled;
  renderCustomReminderOffsets();
  if(task?.weekdays) selectedDays=new Set(task.weekdays);
  operations=(task?.operations||[]).map(o=>({...o}));
  $("deleteTaskButton").hidden=!(task && Cloud.canManageTask(task));
  $("weekdayPicker").hidden=$("taskRepeat").value!=="weekdays";
  renderOperations();
  renderWeekdays();
  $("taskEditor").dataset.initialSnapshot=taskEditorSnapshot();
  const closeButton=$("closeTaskEditor");
  closeButton.onclick=async(event)=>{
    event.preventDefault();
    event.stopPropagation();
    if(!taskEditorHasChanges()){
      $("taskDialog").close();
      return;
    }
    const confirmed=await askWIWYConfirm(
      "Discard changes?",
      "Your unsaved changes will be lost.",
      "Discard changes"
    );
    if(confirmed)$("taskDialog").close();
  };
  $("taskDialog").showModal();
}
function renderOperations() {
  $("operationEditor").innerHTML=operations.map((o,i)=>`<div class="operation-row"><input type="checkbox" ${o.required===false?"":"checked"} data-op-required="${i}" style="width:16px"><input type="text" value="${esc(o.name)}" data-op-name="${i}"><button type="button" class="op-remove" data-op-remove="${i}">×</button></div>`).join("");
}
function renderWeekdays() { document.querySelectorAll("[data-day]").forEach(b=>b.classList.toggle("selected",selectedDays.has(Number(b.dataset.day)))); }
let taskSaveInProgress=false;
async function saveTaskFromForm() {
  if(taskSaveInProgress)return false;
  const id=$("taskId").value, repeat=$("taskRepeat").value;
  const existingTask=id?Cloud.getState().tasks.find(t=>t.id===id):null;
  if(repeat==="weekdays"&&!selectedDays.size){toast("Choose at least one weekday.");return false;}
  const task={id:id||undefined,name:$("taskName").value.trim(),assigneeIds:[...document.querySelectorAll("[data-assignee-option]:checked")].map(o=>o.value),repeat,weekdays:repeat==="weekdays"?[...selectedDays]:[],date:repeat==="once"?(existingTask?.date||window.wiwyTaskDraftDate||keyDate()):null,start:$("taskStart").value||null,end:$("taskEnd").value||null,operations,notes:$("taskNotes").value.trim(),advanceReminderOffsets:selectedReminderOffsets(),completionPushEnabled:$("completionPushEnabled").checked,linkedMealId:existingTask?.linkedMealId||null};
  if(!task.name)return false;
  const errorBox=$("taskFormError");errorBox.hidden=true;errorBox.textContent="";
  const submit=$("taskEditor").querySelector('[type="submit"]');
  taskSaveInProgress=true;if(submit)submit.disabled=true;toast("Creation In Progress");
  try { await Cloud.saveTask(task); $("taskDialog").close(); render(); toast(id?"Task Updated!":"Task Created!"); return true; }
  catch(error) { errorBox.textContent="Could not save task: "+error.message; errorBox.hidden=false; toast("Task could not be saved."); return false; }
  finally {taskSaveInProgress=false;if(submit)submit.disabled=false;}
}
let mealTaskDrafts=[];
function renderMealTaskDrafts() {
  const active=Cloud.getState().people.filter(p=>p.active!==false);
  $("mealTaskRows").innerHTML=mealTaskDrafts.map((t,i)=>`<div class="meal-task-draft" data-meal-task-row="${i}"><label>Task<input data-meal-task-name="${i}" value="${esc(t.name)}" placeholder="e.g. Thaw chicken"></label><div class="form-row"><label>Assigned to<select data-meal-task-assignee="${i}"><option value="">Unassigned</option>${active.map(p=>`<option value="${p.id}" ${t.assigneeId===p.id?"selected":""}>${esc(p.name)}</option>`).join("")}</select></label><label>Date<input type="date" data-meal-task-date="${i}" value="${esc(t.date)}"></label><label>Time<input type="time" data-meal-task-time="${i}" value="${esc(t.time)}"></label></div><button type="button" class="text-button" data-remove-meal-task="${i}">Remove task</button></div>`).join("");
}
function addMealTaskDraft() { mealTaskDrafts.push({name:"",assigneeId:Cloud.getMembership()?.member_profile_id||"",date:$("mealDate").value||keyDate(),time:""});renderMealTaskDrafts(); }
function openMealEditor(meal=null) {
  $("mealEditor").reset();
  $("mealId").value=meal?.id||"";
  $("mealDialogTitle").textContent=meal?"Edit meal":"Add a meal";
  $("mealDate").value=meal?.date||keyDate();
  $("mealType").value=meal?.type||"dinner";
  $("mealName").value=meal?.name||"";
  $("mealNotes").value=meal?.notes||"";
  mealTaskDrafts=[];
  renderMealTaskDrafts();
  const existing=meal?Cloud.getState().tasks.filter(t=>t.linkedMealId===meal.id):[];
  $("existingMealTasks").innerHTML=existing.length?`<p class="label-hint">Already-created tasks (kept when this meal is edited or deleted):</p>${existing.map(t=>`<div class="existing-meal-task">${esc(t.name)} · ${esc(t.start?timeText(t.start):"Anytime")} · ${esc((t.assigneeIds||[]).map(personName).join(", ")||"Unassigned")}</div>`).join("")}`:"";
  $("mealDialog").showModal();
}
async function submitMealEditor() {
  const id=$("mealId").value||undefined;
  const meal={id,date:$("mealDate").value,type:$("mealType").value,name:$("mealName").value.trim(),notes:$("mealNotes").value.trim()};
  if(!meal.date||!meal.name){toast("Choose a date and enter a meal name.");return;}
  const taskDrafts=mealTaskDrafts.map((t,i)=>({name:document.querySelector(`[data-meal-task-name="${i}"]`)?.value.trim()||"",assigneeId:document.querySelector(`[data-meal-task-assignee="${i}"]`)?.value||"",date:document.querySelector(`[data-meal-task-date="${i}"]`)?.value||meal.date,time:document.querySelector(`[data-meal-task-time="${i}"]`)?.value||""})).filter(t=>t.name);
  const mealSubmit=$("mealEditor").querySelector('[type="submit"]');if(mealSubmit)mealSubmit.disabled=true;toast("Creation In Progress");
  try {
    const mealId=await Cloud.saveMeal(meal);
    let made=0,failed=[];
    for(const task of taskDrafts){
      try {
        const taskData={name:task.name,assigneeIds:task.assigneeId?[task.assigneeId]:[],repeat:"once",date:task.date,start:task.time||null,end:null,operations:[],notes:`Preparation for ${meal.name} (${meal.date})`,advanceReminderOffsets:[],completionPushEnabled:false,linkedMealId:mealId};
        const taskId=await Cloud.saveTask(taskData);
        await Cloud.ensureOccurrence(taskId,task.date);
        made++;
      } catch(error){failed.push(`${task.name}: ${error.message}`);}
    }
    $("mealDialog").close();render();
    toast(failed.length?`Meal saved; ${made} task(s) created. ${failed[0]}`:`Meal Created${made?` with ${made} preparation task(s)`:"!"}`);
    if(failed.length>1)console.warn("Additional WIWY meal preparation task errors:",failed.slice(1));
  } catch(error){toast("Could not save meal: "+error.message);}
  finally{if(mealSubmit)mealSubmit.disabled=false;}
}

function setup() {
  document.querySelectorAll(".nav-item[data-view]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b=>b.addEventListener("click",()=>setView(b.dataset.go)));
  $("todayAgenda").addEventListener("click",e=>{const button=e.target.closest("[data-agenda-task]");if(button)openTaskDetails(Cloud.getState().tasks.find(t=>t.id===button.dataset.agendaTask));});
  $("calendarGrid").addEventListener("click",async e=>{
    const taskButton=e.target.closest("[data-calendar-task]");
    if(taskButton){await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskButton.dataset.calendarTask),taskButton.dataset.taskDate||keyDate(calendarDate));return;}
    const dayButton=e.target.closest("[data-month-date]");
    if(dayButton){calendarDate=new Date(dayButton.dataset.monthDate+"T12:00:00");calendarReturnToMonth=calendarMode==="month";calendarMode="day";renderCalendar();}
  });
  $("taskDetailContent").addEventListener("change",async e=>{
    const taskId=e.target.dataset.detailStepTask, operationId=e.target.dataset.detailStepId;
    if(taskId&&operationId){const date=e.target.dataset.detailStepDate||detailDateKey;try{await Cloud.setOperationCompletion(taskId,date,operationId,e.target.checked);render();await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===taskId),date);const t=Cloud.getState().tasks.find(x=>x.id===taskId);if(t?.occurrences?.[date]?.status==="completed")toast("✓ All required steps completed. Task finished.");}catch(error){e.target.checked=!e.target.checked;toast("Could not update step: "+error.message);}}
  });
  $("taskDetailContent").addEventListener("click",async e=>{
    const edit=e.target.closest("[data-detail-edit]"); if(edit){const task=Cloud.getState().tasks.find(t=>t.id===edit.dataset.detailEdit);if(task){$("taskDetailDialog").close();openTask(task);}return;}
    const complete=e.target.closest("[data-detail-complete]"); if(complete)await completeTaskFromDetails(complete.dataset.detailComplete);
    const reopen=e.target.closest("[data-detail-reopen]"); if(reopen&&await askWIWYConfirm("Reopen task?","This will clear the completed steps and return the task to not started.","Reopen task")){try{await Cloud.reopenTask(reopen.dataset.detailReopen,detailDateKey);render();await openTaskDetails(Cloud.getState().tasks.find(t=>t.id===reopen.dataset.detailReopen),detailDateKey);toast("Task reopened.");}catch(error){toast("Could not reopen task: "+error.message);}}
  });
  $("closeTaskDetail").onclick=()=>$("taskDetailDialog").close();
  $("pageBack").onclick=goBack;
  const homeBrand=document.querySelector(".header-brand-row");
  if(homeBrand){homeBrand.style.cursor="pointer";homeBrand.setAttribute("role","button");homeBrand.setAttribute("tabindex","0");const goHome=()=>{viewHistory=[];calendarDate=new Date();calendarDate.setHours(12,0,0,0);calendarMode="day";calendarReturnToMonth=false;setView("today");};homeBrand.addEventListener("click",e=>{if(e.target.closest("#profileButton")||e.target.closest("#accountMenu"))return;goHome();});homeBrand.addEventListener("keydown",e=>{if((e.key==="Enter"||e.key===" ")&&!e.target.closest("#profileButton")){e.preventDefault();goHome();}});}
  const launchTaskEditor = (event) => { event?.preventDefault(); event?.stopPropagation(); try { openTask(); } catch(error) { console.error("Could not open task editor:", error); toast("Could not open the task editor: " + error.message); } };
  $("quickAddTask").addEventListener("click", launchTaskEditor);
  $("newTaskButton").addEventListener("click", launchTaskEditor);
  $("taskRepeat").onchange=()=>{$("weekdayPicker").hidden=$("taskRepeat").value!=="weekdays";};
  document.querySelectorAll("[data-day]").forEach(b=>b.onclick=()=>{const d=Number(b.dataset.day);selectedDays.has(d)?selectedDays.delete(d):selectedDays.add(d);renderWeekdays();});
  $("addOperation").onclick=()=>{const v=$("newOperation").value.trim();if(v){operations.push({name:v,required:true});$("newOperation").value="";renderOperations();}};
  $("operationEditor").addEventListener("click",e=>{const i=e.target.dataset.opRemove;if(i!==undefined){operations.splice(Number(i),1);renderOperations();}});
  $("operationEditor").addEventListener("change",e=>{if(e.target.dataset.opRequired!==undefined)operations[Number(e.target.dataset.opRequired)].required=e.target.checked;if(e.target.dataset.opName!==undefined)operations[Number(e.target.dataset.opName)].name=e.target.value;});
  // Task editor close is bound when the dialog opens, so it cannot be skipped
  // by any later setup-time event wiring.
  $("taskEditor").addEventListener("submit",e=>{e.preventDefault();saveTaskFromForm();});
  $("deleteTaskButton").onclick=async()=>{const id=$("taskId").value;if(id&&await askWIWYConfirm("Delete task?","This removes the task definition. This action cannot be undone.","Delete task")){try{await Cloud.deleteTask(id);$("taskDialog").close();render();toast("Task deleted.");}catch(error){toast("Could not delete task: "+error.message);}}};
  $("taskList").addEventListener("click",async e=>{
    const editButton=e.target.closest("[data-edit-task]");
    if(editButton){const edit=editButton.dataset.editTask;const task=Cloud.getState().tasks.find(t=>t.id===edit);if(task){try{openTask(task);}catch(error){console.error("Could not open task editor:",error);toast("Could not open the task editor: "+error.message);}}return;}
    const completeButton=e.target.closest("[data-complete]");
    const complete=completeButton?.dataset.complete;
    if(complete){const task=Cloud.getState().tasks.find(t=>t.id===complete);try{
      if(task.operations?.length>=2){if(!await askWIWYConfirm("Complete this task?","Are all steps for this task complete? Confirming will mark every step complete.","Complete task"))return;await Cloud.completeAllStepsAndTask(complete,keyDate());}
      else if(task.operations?.length===1){await Cloud.completeAllStepsAndTask(complete,keyDate());}
      else await Cloud.setOccurrence(complete,keyDate(),"completed");
      render();toast("✓ Task completed for everyone.");
    }catch(error){toast("Could not complete task: "+error.message);}}
    const reopen=e.target.dataset.reopenTask;
    if(reopen&&await askWIWYConfirm("Reopen task?","This will clear the completed steps and return the task to not started.","Reopen task")){try{await Cloud.reopenTask(reopen,keyDate());render();toast("Task reopened.");}catch(error){toast("Could not reopen task: "+error.message);}}
  });
  $("taskList").addEventListener("change",async e=>{
    const taskId=e.target.dataset.stepTask, operationId=e.target.dataset.stepId;
    if(taskId&&operationId){try{await Cloud.setOperationCompletion(taskId,keyDate(),operationId,e.target.checked);render();const t=Cloud.getState().tasks.find(x=>x.id===taskId);if(t?.occurrences?.[keyDate()]?.status==="completed")toast("✓ All required steps completed. Task finished.");}catch(error){e.target.checked=!e.target.checked;toast("Could not update step: "+error.message);}}
  });
  document.querySelectorAll("[data-task-filter]").forEach(b=>b.onclick=()=>{taskFilter=b.dataset.taskFilter;document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("selected",x===b));renderTasks();});
  document.querySelectorAll("[data-summary-filter]").forEach(card=>{card.setAttribute("role","button");card.setAttribute("tabindex","0");card.setAttribute("aria-label","Show "+card.dataset.summaryFilter+" tasks");const activate=()=>{taskFilter=card.dataset.summaryFilter;setView("tasks");document.querySelectorAll("[data-task-filter]").forEach(x=>x.classList.toggle("selected",x.dataset.taskFilter===taskFilter));renderTasks();};card.addEventListener("click",activate);card.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();activate();}});});
  $("addPersonButton").onclick=()=>{$("personEditor").reset();$("personEditId").value="";$("personDialogTitle").textContent="Add a person";$("personEditor").querySelector('[type="submit"]').textContent="Add person";$("personFormError").hidden=true;$("personFormError").textContent="";$("personDialog").showModal();};
  $("peopleGrid").addEventListener("change",async event=>{
    const select=event.target.closest("[data-member-role]");
    if(!select)return;
    const next=select.value,previous=select.dataset.currentRole;
    if(next===previous)return;
    if(!await askWIWYConfirm("Change household role?",`Change this account's role from ${previous} to ${next}?`,"Change role")){select.value=previous;return;}
    select.disabled=true;
    try{await Cloud.setMemberRole(select.dataset.memberRole,next);render();toast("Household role updated.");}
    catch(error){select.value=previous;toast("Role change failed: "+error.message);}
    finally{select.disabled=false;}
  });
  async function requestMemberInvitation(person) {
    const dialog=$("memberInviteDialog"), form=$("memberInviteForm");
    $("memberInvitePerson").textContent=`Create an invitation for ${person?.name||"this household member"}.`;
    $("memberInviteEmail").value="";
    $("memberInviteRole").value="Member";
    return new Promise(resolve=>{
      let settled=false;
      const finish=value=>{if(settled)return;settled=true;dialog.close();form.removeEventListener("submit",submit);$("cancelMemberInvite").removeEventListener("click",cancel);$("closeMemberInvite").removeEventListener("click",cancel);dialog.removeEventListener("cancel",onCancel);resolve(value);};
      const submit=event=>{event.preventDefault();if(!form.reportValidity())return;finish({email:$("memberInviteEmail").value.trim(),role:$("memberInviteRole").value});};
      const cancel=()=>finish(null);
      const onCancel=event=>{event.preventDefault();finish(null);};
      form.addEventListener("submit",submit);
      $("cancelMemberInvite").addEventListener("click",cancel);
      $("closeMemberInvite").addEventListener("click",cancel);
      dialog.addEventListener("cancel",onCancel);
      dialog.showModal();
      $("memberInviteEmail").focus();
    });
  }

  $("peopleGrid").addEventListener("click", async event => {
    const editProfile = event.target.closest("[data-profile-edit]");
    if (editProfile) { const p=Cloud.getState().people.find(x=>x.id===editProfile.dataset.profileEdit); if(!p)return; $("personEditor").reset(); $("personEditId").value=p.id; $("personDialogTitle").textContent="Edit profile"; $("personName").value=p.name; $("personEmail").value=p.email||""; $("personPhone").value=p.phone||""; $("personBirthDate").value=p.birthDate||""; $("personNotes").value=p.notes||""; $("personColor").value=p.color||"#789a80"; $("personFormError").hidden=true; $("personDialog").showModal(); return; }
    const toggle = event.target.closest("[data-profile-toggle]");
    const request = event.target.closest("[data-profile-request]");
    const approve = event.target.closest("[data-removal-approve]");
    const decline = event.target.closest("[data-removal-decline]");
    const permanentDelete = event.target.closest("[data-profile-delete]");
    const removeAccess = event.target.closest("[data-profile-access]");
    const inviteProfile = event.target.closest("[data-invite-profile]");
    try {
      if (inviteProfile) {
        const person=Cloud.getState().people.find(p=>p.id===inviteProfile.dataset.inviteProfile);
        const invitation=await requestMemberInvitation(person);
        if(!invitation)return;
        const link=await Cloud.createMemberInvitation(inviteProfile.dataset.inviteProfile,invitation.email,invitation.role);
        try{await navigator.clipboard.writeText(link);toast("Invitation link copied. Send it to "+invitation.email+".");}
        catch{prompt("Copy this invitation link and send it to "+invitation.email+":",link);}
      } else if (toggle) {
        const active = toggle.dataset.nextActive === "true";
        const person = Cloud.getState().people.find(p => p.id === toggle.dataset.profileToggle);
        const accepted = await askWIWYConfirm(active ? "Reactivate household member?" : "Deactivate household member?",
          active ? `Restore ${person?.name || "this person"} to active household lists? Previous task assignments will not be restored automatically.`
                 : `${person?.name || "This person"} will be removed from active assignment lists. Unfinished assignments will be cleared; historical records will remain.`,
          active ? "Reactivate" : "Deactivate");
        if (!accepted) return;
        await Cloud.setProfileActive(toggle.dataset.profileToggle, active);
        populatePeopleSelects(); render();
        toast(active ? "Household member reactivated." : "Household member deactivated. History preserved.");
      } else if (permanentDelete) {
        const profileId=permanentDelete.dataset.profileDelete;
        const person=Cloud.getState().people.find(p=>p.id===profileId);
        const dialog=$("wiwyConfirmDialog");
        $("wiwyConfirmTitle").textContent="Are you sure you want to delete this Member Account?";
        $("wiwyConfirmMessage").innerHTML=`Permanently delete ${esc(person?.name||"this member profile")}? Historical tasks and activity will be retained where possible.`;
        const checkWrap=document.createElement("label");checkWrap.className="delete-access-choice";
        checkWrap.innerHTML='<input type="checkbox" id="deleteHouseholdAccessCheck"> Also Delete Household Login Access?';
        $("wiwyConfirmMessage").appendChild(checkWrap);
        $("wiwyConfirmAccept").textContent="Permanently delete";
        const confirmed=await new Promise(resolve=>{const done=v=>{dialog.close();$("wiwyConfirmAccept").removeEventListener("click",yes);$("wiwyConfirmCancel").removeEventListener("click",no);dialog.removeEventListener("cancel",cancel);resolve(v);};const yes=()=>done(true),no=()=>done(false),cancel=e=>{e.preventDefault();done(false);};$("wiwyConfirmAccept").addEventListener("click",yes);$("wiwyConfirmCancel").addEventListener("click",no);dialog.addEventListener("cancel",cancel);dialog.showModal();});
        if(!confirmed)return;
        const removeLogin=$("deleteHouseholdAccessCheck").checked;
        await Cloud.permanentlyDeleteProfile(profileId,removeLogin);
        populatePeopleSelects();render();toast("Member profile permanently deleted.");
      } else if (removeAccess) {
        const profileId=removeAccess.dataset.profileAccess;
        const person=Cloud.getState().people.find(p=>p.id===profileId);
        if(!await askWIWYConfirm("Remove household login access?",`This will remove ${person?.name||"this member"}'s login access to this household only. Their global account and other household access will remain.`,"Remove access"))return;
        await Cloud.removeHouseholdAccess(profileId);render();toast("Household login access removed.");
      } else if (request) {
        const person = Cloud.getState().people.find(p => p.id === request.dataset.profileRequest);
        if (!await askWIWYConfirm("Request profile removal?", `Send the household Admin a request to deactivate ${person?.name || "this person"}?`, "Send request")) return;
        await Cloud.requestProfileRemoval(request.dataset.profileRequest);
        render(); toast("Removal request sent to the household Admin.");
      } else if (approve || decline) {
        const button = approve || decline;
        const accept = !!approve;
        if (!await askWIWYConfirm(accept ? "Approve removal request?" : "Decline removal request?",
          accept ? "This will deactivate the profile and clear unfinished assignments. Historical records will remain." : "This request will be declined. The person's profile will remain active.",
          accept ? "Approve and deactivate" : "Decline request")) return;
        await Cloud.reviewProfileRemoval(button.dataset.removalApprove || button.dataset.removalDecline, accept);
        populatePeopleSelects(); render();
        toast(accept ? "Request approved. Profile deactivated." : "Removal request declined.");
      }
    } catch (error) {
      toast("People update failed: " + error.message);
    }
  });
  $("closePersonEditor").onclick=(event)=>{event.preventDefault();$("personDialog").close();};
  $("personEditor").addEventListener("submit",async e=>{e.preventDefault();const name=$("personName").value.trim();if(!name)return;const errorBox=$("personFormError");errorBox.hidden=true;errorBox.textContent="";const person={name,color:$("personColor").value,birthDate:$("personBirthDate").value,email:$("personEmail").value,phone:$("personPhone").value,notes:$("personNotes").value};const id=$("personEditId").value;try{if(id){await Cloud.updatePerson(id,person);}else{await Cloud.addPerson(person);}$("personDialog").close();populatePeopleSelects();render();toast(id?"Profile updated.":"✓ Household member added.");}catch(error){errorBox.textContent="Could not save profile: "+error.message;errorBox.hidden=false;}});
  $("addMealButton").onclick=()=>openMealEditor();
  $("closeMealEditor").onclick=()=>$("mealDialog").close();
  $("cancelMealEditor").onclick=()=>$("mealDialog").close();
  $("mealEditor").addEventListener("submit",e=>{e.preventDefault();submitMealEditor();});
  $("addMealTask").onclick=addMealTaskDraft;
  $("mealTaskRows").addEventListener("click",e=>{const b=e.target.closest("[data-remove-meal-task]");if(!b)return;mealTaskDrafts.splice(Number(b.dataset.removeMealTask),1);renderMealTaskDrafts();});
  $("mealTaskRows").addEventListener("input",e=>{const row=e.target.closest("[data-meal-task-row]");if(!row)return;const i=Number(row.dataset.mealTaskRow);if(e.target.dataset.mealTaskName!==undefined)mealTaskDrafts[i].name=e.target.value;if(e.target.dataset.mealTaskAssignee!==undefined)mealTaskDrafts[i].assigneeId=e.target.value;if(e.target.dataset.mealTaskDate!==undefined)mealTaskDrafts[i].date=e.target.value;if(e.target.dataset.mealTaskTime!==undefined)mealTaskDrafts[i].time=e.target.value;});
  $("mealList").addEventListener("click",async e=>{const edit=e.target.closest("[data-edit-meal]");const del=e.target.closest("[data-delete-meal]");if(edit){openMealEditor(Cloud.getState().meals.find(m=>m.id===edit.dataset.editMeal));return;}if(del){const meal=Cloud.getState().meals.find(m=>m.id===del.dataset.deleteMeal);const linked=Cloud.getState().tasks.filter(t=>t.linkedMealId===meal?.id).length;if(!await askWIWYConfirm("Delete this meal?",`Remove ${meal?.name||"this meal"} from the meal plan? ${linked?`${linked} preparation task(s) will remain in WIWY.`:""}`,"Delete meal"))return;try{await Cloud.deleteMeal(del.dataset.deleteMeal);render();toast("Meal removed. Any preparation tasks remain.");}catch(error){toast("Could not remove meal: "+error.message);}}});
  $("groceryForm").onsubmit=async e=>{e.preventDefault();const name=$("groceryInput").value.trim();if(!name)return;try{await Cloud.saveGrocery({name,quantity:$("groceryQuantity").value,category:$("groceryCategory").value,notes:$("groceryNotes").value});$("groceryInput").value="";$("groceryQuantity").value="1";$("groceryNotes").value="";renderGroceries();}catch(error){toast("Could not add shopping item: "+error.message);}};
  $("groceryList").addEventListener("change",async e=>{const id=e.target.dataset.grocery;if(id){try{await Cloud.toggleGrocery(id,e.target.checked);renderGroceries();}catch(error){e.target.checked=!e.target.checked;toast("Could not update item: "+error.message);}}});
  $("groceryList").addEventListener("click",async e=>{const edit=e.target.closest("[data-edit-grocery]");const del=e.target.closest("[data-delete-grocery]");if(edit){const item=Cloud.getState().groceries.find(x=>x.id===edit.dataset.editGrocery);if(!item)return;$("groceryEditId").value=item.id;$("groceryEditName").value=item.name;$("groceryEditQuantity").value=item.quantity;$("groceryEditCategory").value=item.category;$("groceryEditNotes").value=item.notes;$("groceryEditDialog").showModal();return;}if(del){try{await Cloud.deleteGrocery(del.dataset.deleteGrocery);renderGroceries();}catch(error){toast("Could not remove item: "+error.message);}}});
  $("closeGroceryEdit").onclick=()=>$("groceryEditDialog").close();
  $("cancelGroceryEdit").onclick=()=>$("groceryEditDialog").close();
  $("groceryEditForm").addEventListener("submit",async e=>{e.preventDefault();try{await Cloud.updateGrocery($("groceryEditId").value,{name:$("groceryEditName").value,quantity:$("groceryEditQuantity").value,category:$("groceryEditCategory").value,notes:$("groceryEditNotes").value});$("groceryEditDialog").close();renderGroceries();toast("Shopping item updated.");}catch(error){toast("Could not update item: "+error.message);}});
  $("clearGroceries").onclick=async()=>{if(!await askWIWYConfirm("Clear purchased items?","Remove all checked items from the shared shopping list?","Clear completed"))return;try{await Cloud.clearCompletedGroceries();renderGroceries();}catch(error){toast("Could not clear items: "+error.message);}};
  $("saveWorkspace").onclick=async()=>{
    const proposed = $("settingsWorkspace").value.trim();
    if (!proposed) { toast("Enter a workspace name."); return; }
    try {
      authenticatedWorkspace = await renameActiveWorkspace(proposed);
      Store.saveWorkspaceName(proposed);
      render();
      toast("Workspace name saved.");
    } catch (error) { toast("Could not save workspace name: " + error.message); }
  };
  $("exportData").onclick=async()=>{
    const button=$("exportData");
    button.disabled=true;
    const original=button.textContent;
    button.textContent="Preparing cloud backup…";
    try {
      const backup=await Cloud.exportHouseholdBackup();
      const blob=new Blob([JSON.stringify(backup,null,2)],{type:"application/json"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;
      a.download="wiwy-household-backup-"+keyDate()+".json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast("Cloud household backup exported.");
    } catch(error) {
      alert("Could not export household backup: "+error.message);
    } finally {
      button.disabled=false;
      button.textContent=original;
    }
  };

  // Import intake: validate the portable envelope, review profile mapping,
  // then execute the server-side transaction only after explicit confirmation.
  let pendingBackup = null;
  const collectionLabels = {
    people:"Household members",tasks:"Tasks",taskOperations:"Task steps",taskAssignments:"Task assignments",
    taskOccurrences:"Task occurrences",taskOccurrenceAssignees:"Occurrence assignees",
    taskOperationCompletions:"Completed task steps",meals:"Meals",groceries:"Grocery items",
    events:"Calendar events",awayPeriods:"Away periods",activity:"Activity history"
  };
  const requiredCollections = Object.keys(collectionLabels);
  function validateImportBackup(value) {
    const errors=[];
    if (!value || value.format!=="wiwy-household-backup") errors.push("This is not a WIWY household backup.");
    if (value?.schemaVersion!==1) errors.push("Unsupported backup schema version.");
    if (!value?.source?.workspaceId || !value?.source?.workspaceName || !value?.data) errors.push("Backup source information or data is missing.");
    for (const key of requiredCollections) if (!Array.isArray(value?.data?.[key])) errors.push(`Missing or invalid collection: ${key}.`);
    if (errors.length) return errors;
    const data=value.data;
    const ids={};
    for (const key of requiredCollections) {
      ids[key]=new Set();
      for (const row of data[key]) {
        if (!row || typeof row!=="object" || (key!=="taskAssignments" && key!=="taskOccurrenceAssignees" && !row.id)) errors.push(`${key} contains an invalid record.`);
        if (row.id && ids[key].has(row.id)) errors.push(`${key} contains duplicate record IDs.`);
        if (row.id) ids[key].add(row.id);
      }
    }
    const people=ids.people, tasks=ids.tasks, meals=ids.meals, ops=ids.taskOperations, occ=ids.taskOccurrences;
    const ref=(ok,msg)=>{if(!ok)errors.push(msg);};
    data.tasks.forEach(x=>{ref(!x.assignee_profile_id||people.has(x.assignee_profile_id),"A task refers to a missing household member.");ref(!x.linked_meal_id||meals.has(x.linked_meal_id),"A task refers to a missing meal.");});
    data.taskOperations.forEach(x=>ref(tasks.has(x.task_id),"A task step refers to a missing task."));
    data.taskAssignments.forEach(x=>{ref(tasks.has(x.task_id),"A task assignment refers to a missing task.");ref(people.has(x.member_profile_id),"A task assignment refers to a missing member.");});
    data.taskOccurrences.forEach(x=>{ref(tasks.has(x.task_id),"A task occurrence refers to a missing task.");ref(!x.assignee_profile_id||people.has(x.assignee_profile_id),"A task occurrence refers to a missing member.");ref(!x.completed_by_profile_id||people.has(x.completed_by_profile_id),"A completed occurrence refers to a missing member.");});
    data.taskOccurrenceAssignees.forEach(x=>{ref(occ.has(x.occurrence_id),"An occurrence assignment refers to a missing occurrence.");ref(people.has(x.member_profile_id),"An occurrence assignment refers to a missing member.");});
    data.taskOperationCompletions.forEach(x=>{ref(occ.has(x.occurrence_id),"A completed task step refers to a missing occurrence.");ref(ops.has(x.operation_id),"A completed task step refers to a missing task step.");});
    data.groceries.forEach(x=>ref(!x.linked_meal_id||meals.has(x.linked_meal_id),"A grocery item refers to a missing meal."));
    data.events.forEach(x=>ref(!x.assigned_profile_id||people.has(x.assigned_profile_id),"A calendar event refers to a missing member."));
    data.awayPeriods.forEach(x=>ref(!x.member_profile_id||people.has(x.member_profile_id),"An Away Mode period refers to a missing member."));
    data.activity.forEach(x=>ref(!x.actor_profile_id||people.has(x.actor_profile_id),"An activity entry refers to a missing member."));
    return [...new Set(errors)];
  }
  function updateImportModeNotice() {
    const replace=$("importMode").value==="replace";
    $("importModeNotice").innerHTML=replace
      ? "<strong>Replace household content</strong><p>This removes the destination household's existing tasks, task history, meals, groceries, events, Away periods, and activity before importing this backup. Existing profiles, login links, memberships, permissions, and workspace identity are retained. A pre-import snapshot is recorded in the database.</p>"
      : "<strong>Merge household content</strong><p>Existing records are not overwritten. Records with conflicting IDs are skipped. New profiles are created unless you explicitly map them to existing household profiles.</p>";
    $("confirmImportPreview").textContent=replace?"Replace household content":"Merge household data";
  }
  function renderImportPreview(backup) {
    const errors=validateImportBackup(backup);
    $("importFileSummary").textContent=`${backup.source.workspaceName} · exported ${new Date(backup.exportedAt).toLocaleString()} · ${backup.source.timezone||"Timezone not recorded"}`;
    $("importValidation").className="import-validation "+(errors.length?"has-errors":"is-valid");
    $("importValidation").innerHTML=errors.length?`<strong>Backup needs attention</strong><ul>${errors.map(x=>`<li>${escapeHTML(x)}</li>`).join("")}</ul>`:"<strong>Backup structure validated.</strong> All required collections are present and internal references are consistent.";
    $("importCounts").innerHTML=requiredCollections.map(k=>`<div class="import-count"><span>${collectionLabels[k]}</span><strong>${backup.data[k].length}</strong></div>`).join("");
    const existing=Cloud.getState().people;
    $("importProfileMappings").innerHTML=backup.data.people.map(source=>{
      const exact=existing.filter(p=>p.name.trim().toLocaleLowerCase()===source.display_name.trim().toLocaleLowerCase());
      const suggestion=exact.length===1?exact[0].id:"";
      const opts=[`<option value="">Create a separate household profile</option>`,...existing.map(p=>`<option value="${p.id}" ${p.id===suggestion?"selected":""}>${escapeHTML(p.name)}${p.accountId?" · login linked":""}</option>`)].join("");
      return `<label class="import-profile-row"><span><strong>${escapeHTML(source.display_name)}</strong><small>${source.is_active?"Active in backup":"Inactive in backup"}${exact.length>1?" · multiple name matches":exact.length===1?" · suggested match — review":" · no exact match"}</small></span><select data-import-profile="${source.id}">${opts}</select></label>`;
    }).join("")||'<p class="muted">No household profiles in this backup.</p>';
    $("confirmImportPreview").disabled=errors.length>0;
    pendingBackup=errors.length?null:backup;
    updateImportModeNotice();
  }
  $("importData").onclick=()=>$("importFile").click();
  $("importFile").addEventListener("change",async e=>{
    const file=e.target.files?.[0]; e.target.value=""; if(!file)return;
    if(file.size>10*1024*1024){toast("Backup file is larger than the 10 MB safety limit.");return;}
    try {const backup=JSON.parse(await file.text());renderImportPreview(backup);$("importPreviewDialog").showModal();}
    catch(error){alert("Could not read this JSON backup: "+error.message);}
  });
  $("importMode").addEventListener("change",updateImportModeNotice);
  $("closeImportPreview").onclick=()=>$("importPreviewDialog").close();
  $("cancelImportPreview").onclick=()=>$("importPreviewDialog").close();
  $("confirmImportPreview").onclick=async()=>{
    if(!pendingBackup)return;
    const mode=$("importMode").value;
    const confirmMessage=mode==="replace"
      ?"This will replace the household's portable content. Existing profiles, account links, memberships, permissions, and workspace identity are retained. A pre-import snapshot will be recorded. Continue?"
      :"This will merge the backup into the current household. Existing records will not be overwritten. Continue?";
    if(!await askWIWYConfirm(mode==="replace"?"Replace household content?":"Merge household data?",confirmMessage,mode==="replace"?"Replace household":"Merge data"))return;
    const button=$("confirmImportPreview");
    const mapping={};
    document.querySelectorAll("[data-import-profile]").forEach(select=>{if(select.value)mapping[select.dataset.importProfile]=select.value;});
    button.disabled=true;
    button.textContent="Importing household data…";
    try{
      const result=await Cloud.importHouseholdBackup(pendingBackup,mode,mapping);
      $("importPreviewDialog").close();
      pendingBackup=null;
      render();
      const counts=Object.entries(result.counts||{}).map(([key,value])=>`${collectionLabels[key]||key}: ${value}`).join(" · ");
      toast((result.message||"Household import completed.")+(counts?" "+counts:""));
    }catch(error){
      toast("Import failed; the database transaction was rolled back. "+error.message);
      button.disabled=false;
      updateImportModeNotice();
    }
  };

  $("awayButton").onclick=()=>{populatePeopleSelects();$("awayPersonWrap").hidden=true;$("awayScope").onchange=()=>{$("awayPersonWrap").hidden=$("awayScope").value!=="person";};$("awayDialog").showModal();};
  $("closeAwayDialog").onclick=()=>$("awayDialog").close();
  $("awayDialog").addEventListener("cancel",e=>{e.preventDefault();$("awayDialog").close();});
  $("awayEditor").addEventListener("submit",async e=>{e.preventDefault();if(e.submitter?.id!=="enableAwayModeButton"){ $("awayDialog").close(); return; }const scope=$("awayScope").value,submit=e.submitter; if(submit)submit.disabled=true;try{await Cloud.enableAway({scope,memberProfileId:scope==="person"?$("awayPerson").value:null,duration:$("awayDuration").value});$("awayDialog").close();render();toast("✓ Away Mode enabled.");}catch(error){$("awayStatus").textContent=error.message;toast(error.message);}finally{if(submit)submit.disabled=false;}});
  $("awayStatus").addEventListener("click",async e=>{
    const button=e.target.closest("[data-away-period]");
    if(!button)return;
    const periodId=button.dataset.awayPeriod;
    button.disabled=true;
    try{
      await Cloud.disableAway({periodId});
      render();
      toast("Away Mode turned off.");
    }catch(error){
      button.disabled=false;
      toast("Could not turn off Away Mode: "+error.message);
    }
  });
  $("mobileMenu").onclick=()=> {
    if ($("sidebar").classList.contains("open")) closeSidebar();
    else openSidebar();
  };
  $("sidebarBackdrop").onclick=closeSidebar;
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeSidebar(); });
  $("workspaceButton").onclick=()=>toast("Workspace switching will be added with account and invitation support.");
  $("notificationButton").onclick=()=>{renderNotificationCenter();$("notificationDialog").showModal();};
  $("closeNotifications").onclick=()=>$("notificationDialog").close();
  $("notificationCenterContent").addEventListener("click",async e=>{
    const dismiss=e.target.closest("[data-notification-dismiss]");
    if(dismiss){dismiss.disabled=true;try{await Cloud.dismissNotification(dismiss.dataset.notificationDismiss);renderNotificationCenter();}catch(error){dismiss.disabled=false;toast("Could not dismiss notification: "+error.message);}return;}
    const read=e.target.closest("[data-notification-read]");
    if(read){read.disabled=true;try{await Cloud.markNotificationRead(read.dataset.notificationRead);renderNotificationCenter();}catch(error){read.disabled=false;toast("Could not mark notification read: "+error.message);}return;}
    const row=e.target.closest("[data-notification-open]");if(!row)return;
    const taskId=row.dataset.notificationTask;const date=row.dataset.notificationDate||keyDate();
    try{await Cloud.markNotificationRead(row.dataset.notificationOpen);}catch(error){console.warn("Could not mark notification read",error);}
    $("notificationDialog").close();
    if(taskId){const task=Cloud.getState().tasks.find(t=>t.id===taskId);if(task)await openTaskDetails(task,date);else toast("The related task is no longer available.");}
  });
  document.querySelectorAll("[data-reminder-offset]").forEach(x=>x.addEventListener("change",()=>{}));
  $("addCustomReminder").onclick=()=>{
    const amount=Number($("customReminderAmount").value),unit=$("customReminderUnit").value;
    if(!Number.isInteger(amount)||amount<1){toast("Enter a valid reminder interval.");return;}
    const minutes=amount*(unit==="days"?1440:unit==="hours"?60:1);
    if(minutes>43200){toast("Custom reminders can be up to 30 days in advance.");return;}
    if(selectedReminderOffsets().includes(minutes)){toast("That reminder is already selected.");return;}
    customReminderOffsets=[...new Set([...customReminderOffsets,minutes])];
    renderCustomReminderOffsets();
  };
  $("selectedCustomReminders").addEventListener("click",e=>{
    const b=e.target.closest("[data-remove-reminder]");if(!b)return;
    customReminderOffsets=customReminderOffsets.filter(v=>v!==Number(b.dataset.removeReminder));
    renderCustomReminderOffsets();
  });
  $("profileButton").onclick=()=>{
    const menu = $("accountMenu");
    menu.hidden = !menu.hidden;
    $("profileButton").setAttribute("aria-expanded", String(!menu.hidden));
  };
  $("accountMenu").addEventListener("click", async e => {
    const action = e.target.closest("[data-account-action]")?.dataset.accountAction;
    if (!action) return;
    $("accountMenu").hidden = true;
    if (action === "account") { setView("settings"); toast("Account settings will be expanded in a later update."); }
    if (action === "household") { setView("settings"); $("settingsWorkspace").focus(); }
    if (action === "signout") {
      if (!await askWIWYConfirm("Sign out?","Sign out of WIWY on this device?","Sign out")) return;
      try { await window.WIWY_AUTH?.client?.auth.signOut(); location.reload(); }
      catch(error) { toast("Could not sign out: " + error.message); }
    }
  });
  document.addEventListener("click", e => {
    if (!$("accountMenu").hidden && !e.target.closest("#profileButton") && !e.target.closest("#accountMenu")) {
      $("accountMenu").hidden = true;
      $("profileButton").setAttribute("aria-expanded", "false");
    }
  });
  $("observanceSettings").addEventListener("click",async e=>{
    const remove=e.target.closest("[data-delete-observance]");
    if(remove){if(!await askWIWYConfirm("Delete observance?","This removes the custom observance and its future reminders. Existing notification history will remain.","Delete observance"))return;try{toast("Saving Changes…");await saveCustomObservances(customObservances().filter(o=>o.id!==remove.dataset.deleteObservance));renderObservanceSettings();renderCalendar();toast("Observance Deleted!");}catch(error){toast("Could not delete observance: "+error.message);}return;}
    if(e.target.closest("#addCustomObservance")){
      const title=$("customObservanceTitle").value.trim(),date=$("customObservanceDate").value,annual=$("customObservanceAnnual").checked;
      if(!title||!date){toast("Enter an observance name and date.");return;}
      const items=customObservances();items.push({id:"custom-"+crypto.randomUUID(),title,date,annual,category:"custom"});
      const add=e.target.closest("#addCustomObservance");if(add)add.disabled=true;toast("Creation In Progress");
      try{await saveCustomObservances(items);renderObservanceSettings();renderCalendar();toast("Observance Created!");}catch(error){toast("Could not save observance: "+error.message);}finally{if(add)add.disabled=false;}
    }
  });
  $("observanceSettings").addEventListener("click",async e=>{
    const remove=e.target.closest("[data-delete-rule]");if(remove){if(!await askWIWYConfirm("Delete reminder rule?","Future reminders from this rule will stop. Previously generated notifications will remain in your history.","Delete rule"))return;try{await Cloud.deleteReminderRule(remove.dataset.deleteRule);renderObservanceSettings();toast("Reminder rule deleted.");}catch(error){toast("Could not delete reminder rule: "+error.message);}return;}
    const save=e.target.closest("[data-save-rule]"); if(!save)return;
    const id=save.dataset.saveRule, daysInput=document.querySelector(`[data-rule-days="${id}"]`), noteInput=document.querySelector(`[data-rule-note="${id}"]`), recipientsInput=document.querySelector(`[data-rule-recipients="${id}"]`);
    const days=daysInput.value.split(",").map(v=>Number(v.trim())).filter(v=>Number.isInteger(v)&&v>0&&v<=30);
    if(!days.length){toast("Enter one or more reminder offsets in days (1–30). The rule was not changed.");return;}
    try{await Cloud.saveReminderRule(id,{offsets_minutes:days.map(v=>v*1440),note:noteInput.value.trim(),recipient_profile_ids:Array.from(recipientsInput.selectedOptions).map(option=>option.value)});renderObservanceSettings();toast("Reminder rule saved to the household cloud.");}
    catch(error){console.error(error);toast(error.message||"Could not save reminder rule.");}
  });
  $("observanceSettings").addEventListener("change",e=>{
    const prefs=observancePrefs(), target=e.target;
    if(target.matches("[data-observance-category]"))prefs[target.dataset.observanceCategory]=target.checked;
    if(target.matches("[data-observance-item]"))prefs.items[target.dataset.observanceItem]=target.checked;
    saveObservancePrefs(prefs);renderCalendar();
  });
  document.querySelectorAll("[data-cal-mode]").forEach(b=>b.onclick=()=>{calendarMode=b.dataset.calMode;calendarReturnToMonth=false;renderCalendar();});
  $("prevDay").onclick=()=>{if(calendarMode==="day")calendarDate=addDays(calendarDate,-1);else if(calendarMode==="week")calendarDate=addDays(calendarDate,-7);else{const day=calendarDate.getDate();calendarDate.setDate(1);calendarDate.setMonth(calendarDate.getMonth()-1);calendarDate.setDate(Math.min(day,new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,0).getDate()));}renderCalendar();};
  $("nextDay").onclick=()=>{if(calendarMode==="day")calendarDate=addDays(calendarDate,1);else if(calendarMode==="week")calendarDate=addDays(calendarDate,7);else{const day=calendarDate.getDate();calendarDate.setDate(1);calendarDate.setMonth(calendarDate.getMonth()+1);calendarDate.setDate(Math.min(day,new Date(calendarDate.getFullYear(),calendarDate.getMonth()+1,0).getDate()));}renderCalendar();};
  $("calendarReturnMonth").onclick=()=>{calendarMode="month";calendarReturnToMonth=false;renderCalendar();};
  $("calendarToday").onclick=()=>{calendarDate=new Date();calendarDate.setHours(12,0,0,0);calendarMode="day";calendarReturnToMonth=false;renderCalendar();};
  $("calendarAddTask").onclick=()=>openTask(null,keyDate(calendarDate));
  $("calendarDatePicker").value=keyDate(calendarDate);
  $("calendarDatePicker").addEventListener("change",e=>{if(!e.target.value)return;calendarDate=new Date(e.target.value+"T12:00:00");calendarMode="day";calendarReturnToMonth=false;renderCalendar();});
  $("calendarDate").title="Choose date"; $("calendarDate").style.cursor="pointer";
  $("calendarDate").addEventListener("click",()=>{
    if(calendarMode==="month") { const p=$("calendarMonthPicker");p.value=`${calendarDate.getFullYear()}-${String(calendarDate.getMonth()+1).padStart(2,"0")}`;if(p.showPicker)p.showPicker();else p.click(); }
    else { const p=$("calendarDatePicker");p.value=keyDate(calendarDate);if(p.showPicker)p.showPicker();else p.click(); }
  });
  $("calendarMonthPicker").addEventListener("change",e=>{if(!e.target.value)return;calendarDate=new Date(e.target.value+"-01T12:00:00");calendarMode="month";calendarReturnToMonth=false;renderCalendar();});
  render();
}
// Service worker registration and user-controlled activation are managed by setupWIWYUpdates().
(async () => {
  try {
    const auth = await requireAuth();
    window.WIWY_AUTH = auth;
    authenticatedWorkspace = auth.workspace;
    signedInUser = await getSignedInUser();
    await Cloud.initialize(auth.client, auth.workspace, auth.membership, signedInUser);
    const avatar = document.getElementById("profileButton");
    if (avatar) {
      avatar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.7-4 3.2-6 7.5-6s6.8 2 7.5 6"/></svg>';
      avatar.setAttribute("aria-label", "Account menu");
      avatar.setAttribute("aria-haspopup", "true");
      avatar.setAttribute("aria-expanded", "false");
    }
    setup();
    restorePushRegistrationState();
    setupWIWYUpdates();
    checkPersonalDateAlerts();
    window.setInterval(checkPersonalDateAlerts, 60*60*1000);
    document.addEventListener("wiwy-cloud-updated", () => { render(); });
    toast("Connected. Household tasks are syncing.");
  } catch (error) {
    console.error("WIWY authentication startup:", error);
    const msg = document.getElementById("authMessage");
    if (msg) { msg.textContent = "WIWY could not load shared household data: " + (error.message || "Unknown connection error") + ". Refresh the page and try again."; msg.classList.add("error"); document.getElementById("authGate").hidden = false; }
  }
})();
