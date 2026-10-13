import {createHash} from 'node:crypto';
import {normalizeAppearance,defaultAppearance} from './dist/announcement-appearance.js';

// This module owns only community_* tables. No message bodies enter portal_state
// or the audit log. All calls run in PortalService's serialized authenticated queue.
export const COMMUNITY_LIMITS=Object.freeze({posts:10000,comments:100000,chat:5000,notes:10000,keys:200000,retentionDays:30,title:120,postBody:8000,commentBody:4000,chatBody:2000,page:100});
const DAY=86400000,MINUTE=60000;
const KINDS=['feedback','discussion','announcement'],STATUSES=['open','investigating','resolved','closed'],ANNOUNCEMENTS=['notice','maintenance','outage'];
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const nowISO=now=>new Date(now).toISOString();
function fields(args,allowed){if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed.includes(k)))fail('社区参数无效。');}
function text(value,max,label){
  if(typeof value!=='string'||value.length>max*2||Buffer.byteLength(value,'utf8')>max*3||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||!value.isWellFormed())fail(`${label}格式无效或超过 ${max} 字限制。`);
  value=value.replace(/\r\n?/g,'\n').trim();
  if(!value||[...value].length>max)fail(`${label}须为 1–${max} 字。`);return value;
}
function id(value){if(typeof value!=='string'||!/^[1-9][0-9]{0,14}$/.test(value)||!Number.isSafeInteger(Number(value)))fail('内容编号无效。');return Number(value);}
function key(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))fail('提交须带有效 UUID key；重试请沿用原 key。');return value.toLowerCase();}
function page(value,max=100){if(value===undefined)return Math.min(50,max);if(!Number.isInteger(value)||value<1||value>max)fail(`每页数量须为 1–${max}。`);return value;}
function revision(value){if(!Number.isSafeInteger(value)||value<1)fail('须提供当前内容 revision。');return value;}
function choice(value,values,label){if(!values.includes(value))fail(`${label}无效。`);return value;}
function author(service,userId){const user=service.store.users.find(u=>u.id===userId);return {id:userId,name:user?.name||'已删除账号',username:user?.username||null};}
function editable(row,actor){return row.kind==='announcement'?actor.role==='admin':row.author_id===actor.userId;}
function deletable(row,actor){return actor.role==='admin'||editable(row,actor);}
function view(service,row,actor,type){
  if(!row)return null;
  const common={id:String(row.id),body:row.body,author:author(service,row.author_id),createdAt:nowISO(row.created_at),updatedAt:nowISO(row.updated_at),revision:row.revision,canEdit:editable(row,actor),canDelete:deletable(row,actor)};
  if(type==='post')return {...common,kind:row.kind,title:row.title,announcementType:row.announcement_type,status:row.status,pinned:!!row.pinned,
    ...(row.kind==='announcement'?{popup:!!row.popup,appearance:JSON.parse(row.appearance_json),...(actor.role==='admin'?{audience:audienceOf(row)}:{})}:{}),
    commentCount:service.db.prepare('SELECT count(*) AS n FROM community_comments WHERE post_id=?').get(row.id).n,canModerate:actor.role==='admin'};
  return type==='comment'?{...common,postId:String(row.post_id)}:type==='note'?{...common,jobId:row.job_id}:common;
}
const tables={post:'community_posts',comment:'community_comments',message:'community_chat',note:'community_notes'};
function get(service,type,value){return service.db.prepare(`SELECT * FROM ${tables[type]} WHERE id=?`).get(value);}
function required(service,type,value){const row=get(service,type,id(value));if(!row)fail('内容不存在或已删除。',404);return row;}
function admin(actor){if(actor.role!=='admin')fail('此操作需要管理员权限。',403);}
function appearance(value){try{return normalizeAppearance(value);}catch(error){fail(error.message);}}
function normalizeAudience(service,value={type:'all'}){
  fields(value,value?.type==='users'?['type','userIds']:value?.type==='role'?['type','role']:['type']);
  if(value.type==='all')return {type:'all'};
  if(value.type==='role')return {type:'role',role:choice(value.role,['admin','member'],'公告受众角色')};
  if(value.type!=='users'||!Array.isArray(value.userIds)||!value.userIds.length||value.userIds.length>200||
    value.userIds.some(id=>typeof id!=='string'||!service.store.users.some(u=>u.id===id)))fail('请选择存在的公告接收成员（最多 200 人）。');
  return {type:'users',userIds:[...new Set(value.userIds)].sort()};
}
const audienceOf=row=>JSON.parse(row.audience_json||'{"type":"all"}');
function receives(row,actor){const a=audienceOf(row);return a.type==='all'||a.type==='role'&&a.role===actor.role||a.type==='users'&&a.userIds.includes(actor.userId);}
function readablePost(service,actor,value){
  const row=required(service,'post',value);
  if(row.kind==='announcement'&&actor.role!=='admin'&&!receives(row,actor))fail('内容不存在或不可见。',404);
  return row;
}
// Filter before pagination, never send other people's targeted titles/bodies
// and rely on the browser to hide them. Admins retain announcement management.
const audienceSQL=`(json_extract(audience_json,'$.type')='all' OR
  (json_extract(audience_json,'$.type')='role' AND json_extract(audience_json,'$.role')=?) OR
  (json_extract(audience_json,'$.type')='users' AND EXISTS (SELECT 1 FROM json_each(audience_json,'$.userIds') WHERE value=?)))`;
export function announcementState(service,actor){
  const rows=service.db.prepare(`SELECT id,revision FROM community_posts p WHERE kind='announcement' AND popup=1 AND ${audienceSQL}
    AND NOT EXISTS (SELECT 1 FROM announcement_acknowledgements a WHERE a.user_id=? AND a.post_id=p.id AND a.revision=p.revision)
    ORDER BY pinned DESC,id DESC LIMIT 10`).all(actor.role,actor.userId,actor.userId);
  return {version:1,pending:rows.map(r=>({id:String(r.id),revision:r.revision}))};
}
function prune(db,now){
  const before=now-COMMUNITY_LIMITS.retentionDays*DAY;
  db.prepare('DELETE FROM community_keys WHERE created_at<?').run(before);
  db.prepare('DELETE FROM community_chat WHERE created_at<?').run(before);
  db.prepare('DELETE FROM community_chat WHERE id <= COALESCE((SELECT id FROM community_chat ORDER BY id DESC LIMIT 1 OFFSET ?),0)').run(COMMUNITY_LIMITS.chat);
  db.prepare('DELETE FROM community_rate WHERE until_ms<=?').run(now);
}
export function pruneTaskNotes(service){
  // Missing/UNKNOWN/LOST is NOT a confirmed end. General notes have no job_id
  // and intentionally survive both task cleanup and the public chat's TTL.
  const linked=service.db.prepare('SELECT DISTINCT job_id FROM community_notes WHERE job_id IS NOT NULL').all();
  if(!linked.length)return 0;
  // Reconciliation mutates memory before save(). A failed portal_state write
  // must not let its finally hook (or a community read) erase durable bodies.
  const saved=service.db.prepare('SELECT data FROM portal_state WHERE id=1').get();
  const ended=new Set((saved?JSON.parse(saved.data).jobs:[]).filter(j=>['SUCCEEDED','FAILED','CANCELED'].includes(j.state)).map(j=>j.id));
  if(!ended.size)return 0;
  const ids=linked.map(r=>r.job_id).filter(id=>ended.has(id));
  if(!ids.length)return 0;
  const db=service.db;let removed=0;db.exec('SAVEPOINT task_notes_cleanup');
  try{const del=db.prepare('DELETE FROM community_notes WHERE job_id=?');for(const id of ids)removed+=Number(del.run(id).changes);db.exec('RELEASE task_notes_cleanup');return removed;}
  catch(error){db.exec('ROLLBACK TO task_notes_cleanup; RELEASE task_notes_cleanup');throw error;}
}
export function maintainTaskNotes(service){
  try{
    if(service.globalMaintenanceActive?.())return 0;
    const removed=service.pruneTaskNotes?.();
    service.noteCleanupPending=false;
    return removed;
  }catch{
    if(!service.noteCleanupPending)console.warn('GPUQ: task note cleanup is pending; training status is preserved.');
    service.noteCleanupPending=true;
    return 0;
  }
}
export function installCommunity(service){
  service.db.exec(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('feedback','discussion','announcement')),
      title TEXT NOT NULL, body TEXT NOT NULL, announcement_type TEXT,
      status TEXT NOT NULL DEFAULT 'open', pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_posts_order ON community_posts(pinned DESC,id DESC);
    CREATE TABLE IF NOT EXISTS community_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, author_id TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_comments_post ON community_comments(post_id,id);
    CREATE TABLE IF NOT EXISTS community_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_chat_age ON community_chat(created_at);
    CREATE TABLE IF NOT EXISTS community_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, job_id TEXT,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_notes_job ON community_notes(job_id);
    CREATE TABLE IF NOT EXISTS community_keys (
      author_id TEXT NOT NULL, client_key TEXT NOT NULL, operation TEXT NOT NULL,
      digest TEXT NOT NULL, entity_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(author_id,client_key)
    );
    CREATE INDEX IF NOT EXISTS community_keys_age ON community_keys(created_at);
    CREATE TABLE IF NOT EXISTS community_rate (
      author_id TEXT NOT NULL, bucket TEXT NOT NULL, count INTEGER NOT NULL, until_ms INTEGER NOT NULL,
      PRIMARY KEY(author_id,bucket)
    );
  `);
  const columns=service.db.prepare('PRAGMA table_info(community_posts)').all().map(row=>row.name);
  if(!columns.includes('audience_json'))service.db.exec(`ALTER TABLE community_posts ADD COLUMN audience_json TEXT NOT NULL DEFAULT '{"type":"all"}'`);
  if(!columns.includes('popup'))service.db.exec('ALTER TABLE community_posts ADD COLUMN popup INTEGER NOT NULL DEFAULT 0');
  if(!columns.includes('appearance_json'))service.db.exec(`ALTER TABLE community_posts ADD COLUMN appearance_json TEXT NOT NULL DEFAULT '${JSON.stringify(defaultAppearance)}'`);
  service.db.exec(`CREATE TABLE IF NOT EXISTS announcement_acknowledgements (
    user_id TEXT NOT NULL,post_id INTEGER NOT NULL,revision INTEGER NOT NULL,acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,post_id))`);
  // Retention is also enforced on reads; this reclaims expired content at startup
  // and on writes without a background process or a full-history JSON rewrite.
  if(!service.globalMaintenanceActive?.())prune(service.db,Date.now());
  service.pruneTaskNotes=()=>pruneTaskNotes(service);
}
function rate(db,actor,bucket,limit,now){
  const current=db.prepare('SELECT count,until_ms FROM community_rate WHERE author_id=? AND bucket=?').get(actor.userId,bucket);
  if(current&&current.until_ms>now&&current.count>=limit)fail('社区操作过于频繁，请一分钟后重试。',429);
  db.prepare('INSERT INTO community_rate(author_id,bucket,count,until_ms) VALUES(?,?,1,?) ON CONFLICT(author_id,bucket) DO UPDATE SET count=CASE WHEN until_ms>? THEN count+1 ELSE 1 END,until_ms=CASE WHEN until_ms>? THEN until_ms ELSE excluded.until_ms END').run(actor.userId,bucket,now+MINUTE,now,now);
}
function capacity(db,table,limit){if(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n>=limit)fail('社区存储容量已达上限，请联系管理员整理后重试。',507);}
function create(service,actor,operation,args,type,canonical,now,insert){
  const db=service.db,clientKey=key(args.key),digest=createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  prune(db,now);
  const existing=db.prepare('SELECT * FROM community_keys WHERE author_id=? AND client_key=?').get(actor.userId,clientKey);
  if(existing){
    if(existing.operation!==operation||existing.digest!==digest)fail('同一 key 不能用于不同内容。',409);
    const row=get(service,type,existing.entity_id);
    return {[type]:view(service,row,actor,type),id:String(existing.entity_id),deleted:!row,duplicate:true};
  }
  capacity(db,'community_keys',COMMUNITY_LIMITS.keys);
  rate(db,actor,'writes',60,now);rate(db,actor,type,{post:3,comment:10,message:20,note:20}[type],now);
  if(type!=='message')capacity(db,tables[type],COMMUNITY_LIMITS[type==='post'?'posts':type==='note'?'notes':'comments']);
  const entityId=Number(insert());
  db.prepare('INSERT INTO community_keys(author_id,client_key,operation,digest,entity_id,created_at) VALUES(?,?,?,?,?,?)').run(actor.userId,clientKey,operation,digest,entityId,now);
  if(type==='message')prune(db,now);
  service.audit(actor.username,operation,String(entityId),'ok');
  return {[type]:view(service,get(service,type,entityId),actor,type),duplicate:false};
}
function postCursor(value,kind,status){
  if(value===undefined)return null;
  if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))fail('分页游标无效。');
  let cursor;try{cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('分页游标无效。');}
  if(!cursor||cursor.v!==1||cursor.k!==kind||cursor.s!==status||![0,1].includes(cursor.p))fail('分页游标与筛选条件不匹配。');
  id(cursor.i);return cursor;
}
function listPosts(service,actor,args){
  fields(args,['kind','status','cursor','limit']);const limit=page(args.limit,50),kind=args.kind===undefined?null:choice(args.kind,KINDS,'帖子类型'),status=args.status===undefined?null:choice(args.status,STATUSES,'状态');
  const cursor=postCursor(args.cursor,kind,status),where=[],params=[];
  if(actor.role!=='admin'){where.push(`(kind!='announcement' OR ${audienceSQL})`);params.push(actor.role,actor.userId);}
  if(kind){where.push('kind=?');params.push(kind);}if(status){where.push('status=?');params.push(status);}
  if(cursor){where.push('(pinned<? OR (pinned=? AND id<?))');params.push(cursor.p,cursor.p,id(cursor.i));}
  const rows=service.db.prepare(`SELECT * FROM community_posts ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY pinned DESC,id DESC LIMIT ?`).all(...params,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);
  const last=rows.at(-1);return {posts:rows.map(r=>view(service,r,actor,'post')),nextCursor:more?Buffer.from(JSON.stringify({v:1,k:kind,s:status,p:last.pinned,i:String(last.id)})).toString('base64url'):null};
}
function listComments(service,actor,args){
  fields(args,['postId','cursor','limit']);const post=readablePost(service,actor,args.postId),limit=page(args.limit),cursor=args.cursor===undefined?0:id(args.cursor);
  const rows=service.db.prepare('SELECT * FROM community_comments WHERE post_id=? AND id>? ORDER BY id LIMIT ?').all(post.id,cursor,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);
  return {comments:rows.map(r=>view(service,r,actor,'comment')),nextCursor:more?String(rows.at(-1).id):null};
}
function listChat(service,actor,args,now){
  fields(args,['before','after','limit']);if(args.before!==undefined&&args.after!==undefined)fail('before 与 after 不能同时指定。');
  const limit=page(args.limit),after=args.after===undefined?null:id(args.after),before=args.before===undefined?null:id(args.before),cutoff=now-COMMUNITY_LIMITS.retentionDays*DAY;
  const where=['created_at>=?'],params=[cutoff];if(after!==null){where.push('id>?');params.push(after);}if(before!==null){where.push('id<?');params.push(before);}
  const rows=service.db.prepare(`SELECT * FROM community_chat WHERE ${where.join(' AND ')} ORDER BY id ${after!==null?'ASC':'DESC'} LIMIT ?`).all(...params,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);if(after===null)rows.reverse();
  const latest=service.db.prepare('SELECT max(id) AS id FROM community_chat WHERE created_at>=?').get(cutoff).id;
  return {messages:rows.map(r=>view(service,r,actor,'message')),nextCursor:rows.length?String(after!==null?rows.at(-1).id:rows[0].id):null,latestCursor:latest===null?null:String(latest),hasMore:more};
}
function change(service,actor,operation,args,type,remove,now){
  fields(args,remove?['id','revision']:type==='post'?['id','revision','title','body','status','pinned','announcementType','audience','popup','appearance']:['id','revision','body']);
  const row=required(service,type,args.id);revision(args.revision);
  if(type==='post')readablePost(service,actor,args.id);
  if(type==='comment')readablePost(service,actor,String(row.post_id));
  if(remove){if(!deletable(row,actor))fail('不能删除其他成员的内容。',403);}
  else{
    if(Object.keys(args).length===2)fail('没有需要修改的字段。');
    if((type!=='post'||args.title!==undefined||args.body!==undefined)&&!editable(row,actor))fail('只能编辑自己发表的内容。',403);
    if(type==='post'&&['status','pinned','announcementType'].some(k=>Object.hasOwn(args,k)))admin(actor);
    if(type==='post'&&row.kind==='announcement')admin(actor);
  }
  if(row.revision!==args.revision)fail('内容已被修改，请刷新后重试。',409);
  rate(service.db,actor,'writes',60,now);
  if(remove){
    if(type==='post'){service.db.prepare('DELETE FROM community_comments WHERE post_id=?').run(row.id);service.db.prepare('DELETE FROM announcement_acknowledgements WHERE post_id=?').run(row.id);}
    service.db.prepare(`DELETE FROM ${tables[type]} WHERE id=?`).run(row.id);
    service.audit(actor.username,operation,String(row.id),'ok');return {deleted:true,id:String(row.id)};
  }
  if(type==='post'){
    const title=args.title===undefined?row.title:text(args.title,COMMUNITY_LIMITS.title,'标题'),body=args.body===undefined?row.body:text(args.body,COMMUNITY_LIMITS.postBody,'正文');
    const status=args.status===undefined?row.status:choice(args.status,STATUSES,'反馈状态');
    if(args.status!==undefined&&row.kind!=='feedback')fail('只有反馈帖子可标记处理状态。');
    if(args.pinned!==undefined&&typeof args.pinned!=='boolean')fail('pinned 必须为布尔值。');
    if(args.pinned!==undefined&&row.kind!=='announcement')fail('只有公告可置顶。');
    if(args.announcementType!==undefined&&row.kind!=='announcement')fail('只有公告可设置公告类型。');
    const announcementType=args.announcementType===undefined?row.announcement_type:choice(args.announcementType,ANNOUNCEMENTS,'公告类型');
    if(row.kind!=='announcement'&&['audience','popup','appearance'].some(k=>args[k]!==undefined))fail('只有公告可以指定受众、弹窗或外观。');
    if(args.popup!==undefined&&typeof args.popup!=='boolean')fail('弹窗设置无效。');
    const audience=args.audience===undefined?audienceOf(row):normalizeAudience(service,args.audience),popup=args.popup===undefined?row.popup:Number(args.popup);
    const style=args.appearance===undefined?row.appearance_json:JSON.stringify(appearance(args.appearance));
    if(args.pinned===true&&!row.pinned&&service.db.prepare('SELECT count(*) AS n FROM community_posts WHERE pinned=1').get().n>=20)fail('最多置顶 20 条公告。',409);
    service.db.prepare('UPDATE community_posts SET title=?,body=?,status=?,pinned=?,announcement_type=?,audience_json=?,popup=?,appearance_json=?,updated_at=?,revision=revision+1 WHERE id=?').run(title,body,status,args.pinned===undefined?row.pinned:Number(args.pinned),announcementType,JSON.stringify(audience),popup,style,now,row.id);
  }else{
    const body=text(args.body,COMMUNITY_LIMITS[type==='comment'?'commentBody':'chatBody'],'正文');
    service.db.prepare(`UPDATE ${tables[type]} SET body=?,updated_at=?,revision=revision+1 WHERE id=?`).run(body,now,row.id);
  }
  service.audit(actor.username,operation,String(row.id),'ok');return {[type]:view(service,get(service,type,row.id),actor,type)};
}
function dispatch(service,actor,operation,args,now){
  const db=service.db;
  if(operation==='community.announcements.pending'){
    fields(args,[]);return {posts:announcementState(service,actor).pending.map(p=>view(service,required(service,'post',p.id),actor,'post'))};
  }
  if(operation==='community.announcements.ack'){
    fields(args,['id','revision']);const row=readablePost(service,actor,args.id);revision(args.revision);
    if(row.kind!=='announcement'||!receives(row,actor))fail('公告不面向当前账号。',404);
    if(row.revision!==args.revision)fail('公告已更新，请阅读最新内容。',409);
    db.prepare(`INSERT INTO announcement_acknowledgements(user_id,post_id,revision,acknowledged_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,post_id) DO UPDATE SET revision=excluded.revision,acknowledged_at=excluded.acknowledged_at`).run(actor.userId,row.id,row.revision,now);
    return {acknowledged:true,id:String(row.id),revision:row.revision,announcements:announcementState(service,actor)};
  }
  if(operation==='community.notes.get'){fields(args,['id']);return {note:view(service,required(service,'note',args.id),actor,'note')};}
  if(operation==='community.notes.list'){
    fields(args,['before','limit']);const limit=page(args.limit),before=args.before===undefined?null:id(args.before);
    const rows=db.prepare('SELECT * FROM community_notes'+(before===null?'':' WHERE id<?')+' ORDER BY id DESC LIMIT ?').all(...(before===null?[]:[before]),limit+1);
    const more=rows.length>limit;rows.length=Math.min(rows.length,limit);
    return {notes:rows.map(row=>view(service,row,actor,'note')),nextCursor:more?String(rows.at(-1).id):null};
  }
  if(operation==='community.notes.create'){
    fields(args,['key','body','jobId']);const body=text(args.body,COMMUNITY_LIMITS.chatBody,'留言'),jobId=args.jobId??null;
    if(jobId!==null&&(typeof jobId!=='string'||!jobId||jobId.length>128))fail('任务 ID 无效。');
    const task=jobId===null?null:service.store.jobs.find(j=>j.id===jobId);
    if(jobId!==null&&(!task||(actor.role!=='admin'&&task.userId!==actor.userId)))fail('只能给自己的任务关联留言。',403);
    return create(service,actor,operation,args,'note',{body,jobId},now,()=>{
      // Check after deduplication: an uncertain retry after cleanup must return
      // the old deleted receipt, never resurrect a completed task's message.
      if(task&&['SUCCEEDED','FAILED','CANCELED'].includes(task.state))fail('任务已结束；长期通知请使用非任务留言。',409);
      return db.prepare('INSERT INTO community_notes(author_id,job_id,body,created_at,updated_at) VALUES(?,?,?,?,?)').run(actor.userId,jobId,body,now,now).lastInsertRowid;
    });
  }
  if(operation==='community.info'){fields(args,[]);return {enabled:true,version:2,limits:{...COMMUNITY_LIMITS,titleBytes:COMMUNITY_LIMITS.title*3,postBodyBytes:COMMUNITY_LIMITS.postBody*3,commentBodyBytes:COMMUNITY_LIMITS.commentBody*3,chatBodyBytes:COMMUNITY_LIMITS.chatBody*3,postsPerMinute:3,commentsPerMinute:10,chatPerMinute:20,writesPerMinute:60},capabilities:['posts','announcements','comments','chat','idempotency-30d','announcement-publish-v1','revision-check','task-notes-v1']};}
  if(operation==='community.posts.list')return listPosts(service,actor,args);
  if(operation==='community.posts.get'){fields(args,['id']);return {post:view(service,readablePost(service,actor,args.id),actor,'post')};}
  if(operation==='community.comments.list')return listComments(service,actor,args);
  if(operation==='community.chat.list')return listChat(service,actor,args,now);
  if(operation==='community.posts.create'){
    fields(args,['key','kind','title','body','announcementType','pinned','audience','popup','appearance']);const kind=choice(args.kind,KINDS,'帖子类型');
    if(kind==='announcement')admin(actor);else if(['announcementType','pinned','audience','popup','appearance'].some(k=>args[k]!==undefined))fail('只有管理员公告可设置公告类型、受众、弹窗或外观。');
    if(args.pinned!==undefined&&typeof args.pinned!=='boolean')fail('pinned 必须为布尔值。');
    if(args.popup!==undefined&&typeof args.popup!=='boolean')fail('弹窗设置无效。');
    const audience=normalizeAudience(service,args.audience),popup=args.popup===true;
    const style=appearance(args.appearance);
    const title=text(args.title,COMMUNITY_LIMITS.title,'标题'),body=text(args.body,COMMUNITY_LIMITS.postBody,'正文'),announcementType=kind==='announcement'?choice(args.announcementType??'notice',ANNOUNCEMENTS,'公告类型'):null;
    // Omit false from the digest so retries from older clients keep matching.
    const canonical={kind,title,body,announcementType,...(args.pinned===true?{pinned:true}:{}),...(popup?{popup:true}:{}),...(audience.type!=='all'?{audience}:{}),...(JSON.stringify(style)!==JSON.stringify(defaultAppearance)?{appearance:style}:{})};
    return create(service,actor,operation,args,'post',canonical,now,()=>{
      if(args.pinned===true&&db.prepare('SELECT count(*) AS n FROM community_posts WHERE pinned=1').get().n>=20)fail('最多置顶 20 条公告。',409);
      return db.prepare('INSERT INTO community_posts(author_id,kind,title,body,announcement_type,pinned,audience_json,popup,appearance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(actor.userId,kind,title,body,announcementType,Number(args.pinned===true),JSON.stringify(audience),Number(popup),JSON.stringify(style),now,now).lastInsertRowid;
    });
  }
  if(operation==='community.comments.create'){
    fields(args,['key','postId','body']);const postId=id(args.postId),body=text(args.body,COMMUNITY_LIMITS.commentBody,'评论');
    if(get(service,'post',postId))readablePost(service,actor,args.postId);
    // Validate parent inside insert: a retry after deletion must return a durable
    // deleted receipt instead of re-creating content or losing idempotency.
    return create(service,actor,operation,args,'comment',{postId,body},now,()=>{readablePost(service,actor,args.postId);return db.prepare('INSERT INTO community_comments(post_id,author_id,body,created_at,updated_at) VALUES(?,?,?,?,?)').run(postId,actor.userId,body,now,now).lastInsertRowid;});
  }
  if(operation==='community.chat.send'){
    fields(args,['key','body']);const body=text(args.body,COMMUNITY_LIMITS.chatBody,'消息');
    return create(service,actor,operation,args,'message',{body},now,()=>db.prepare('INSERT INTO community_chat(author_id,body,created_at,updated_at) VALUES(?,?,?,?)').run(actor.userId,body,now,now).lastInsertRowid);
  }
  for(const [prefix,type] of [['posts','post'],['comments','comment'],['chat','message'],['notes','note']]){
    if(operation===`community.${prefix}.update`)return change(service,actor,operation,args,type,false,now);
    if(operation===`community.${prefix}.delete`)return change(service,actor,operation,args,type,true,now);
  }
  fail('未知社区操作。');
}
export function communityCall(service,principal,operation,args){
  const user=service.store.users.find(u=>u.id===principal.userId);
  if(!user?.enabled)fail('账号已暂停或不存在。',403);
  if(user.role!==principal.role||user.username!==principal.username)fail('账号权限已改变，请重新登录。',401);
  const now=Date.now();service.db.exec('BEGIN IMMEDIATE');
  try{pruneTaskNotes(service);const result=dispatch(service,principal,operation,args,now);service.db.exec('COMMIT');return {...result,serverTime:nowISO(now)};}
  catch(error){service.db.exec('ROLLBACK');throw error;}
}
