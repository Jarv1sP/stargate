import {selectFields} from './portal-request-validation.mjs';
import {normalizeAppearance,defaultAppearance} from './dist/announcement-appearance.js';
import {CHAT_IMAGE,mentionedUsers} from './dist/chat-content.js';

// This module owns only community_* tables. No message bodies enter portal_state
// or the audit log. All calls run in PortalService's serialized authenticated queue.
export const COMMUNITY_LIMITS=Object.freeze({chat:5000,retentionDays:30,title:120,postBody:8000,commentBody:4000,chatBody:2000,page:100,chatImageBytes:CHAT_IMAGE.maxBytes,chatImagesTotalBytes:256*1024**2});
const DAY=86400000;
const KINDS=['feedback','discussion','announcement'],STATUSES=['open','investigating','resolved','closed'],ANNOUNCEMENTS=['notice','maintenance','outage'];
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const nowISO=now=>new Date(now).toISOString();
function text(value,max,label){
  if(typeof value!=='string'||value.length>max*2||Buffer.byteLength(value,'utf8')>max*3||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||!value.isWellFormed())fail(`${label}格式无效或超过 ${max} 字限制。`);
  value=value.replace(/\r\n?/g,'\n').trim();
  if(!value||[...value].length>max)fail(`${label}须为 1–${max} 字。`);return value;
}
function id(value){if(typeof value!=='string'||!/^[1-9][0-9]{0,14}$/.test(value)||!Number.isSafeInteger(Number(value)))fail('内容编号无效。');return Number(value);}
function key(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))fail('提交须带有效 UUID key；重试请沿用原 key。');return value.toLowerCase();}
function page(value,max=100){if(value===undefined)return Math.min(50,max);if(!Number.isInteger(value)||value<1||value>max)fail(`每页数量须为 1–${max}。`);return value;}
function choice(value,values,label){if(!values.includes(value))fail(`${label}无效。`);return value;}
function author(service,userId){const user=service.store.users.find(u=>u.id===userId);return {id:userId,name:user?.name||'已删除账号',username:user?.username||null};}
function editable(row,actor){return row.kind!=='announcement'||actor.role==='admin';}
function deletable(row,actor){return actor.role==='admin'||editable(row,actor);}
function view(service,row,actor,type){
  if(!row)return null;
  const common={id:String(row.id),body:row.body,author:author(service,row.author_id),createdAt:nowISO(row.created_at),updatedAt:nowISO(row.updated_at),revision:row.revision,canEdit:editable(row,actor),canDelete:deletable(row,actor)};
  if(type==='post')return {...common,kind:row.kind,title:row.title,announcementType:row.announcement_type,status:row.status,pinned:!!row.pinned,
    ...(row.kind==='announcement'?{popup:!!row.popup,appearance:JSON.parse(row.appearance_json),...(actor.role==='admin'?{audience:audienceOf(row)}:{})}:{}),
    commentCount:service.db.prepare('SELECT count(*) AS n FROM community_comments_v2 WHERE post_id=?').get(row.id).n,canModerate:actor.role==='admin'};
  if(type==='message'){
    // Only the size travels with the list; the bytes are fetched once per image and cached.
    const image=service.db.prepare('SELECT width,height FROM community_chat_images_v2 WHERE message_id=?').get(row.id);
    return image?{...common,image:{url:'/community/chat-images/'+row.id,width:image.width,height:image.height}}:common;
  }
  return type==='comment'?{...common,postId:String(row.post_id)}:type==='note'?{...common,jobId:row.job_id}:common;
}
const tables={post:'community_posts_v2',comment:'community_comments_v2',message:'community_chat_v2',note:'community_notes_v2'};
function get(service,type,value){return service.db.prepare(`SELECT * FROM ${tables[type]} WHERE id=?`).get(value);}
function required(service,type,value){const row=get(service,type,id(value));if(!row)fail('内容不存在或已删除。',404);return row;}
function admin(actor){if(actor.role!=='admin')fail('此操作需要管理员权限。',403);}
function appearance(value){try{return normalizeAppearance(value);}catch(error){fail(error.message);}}
function normalizeAudience(service,value={type:'all'}){
  value=selectFields(value,value?.type==='users'?['type','userIds']:value?.type==='role'?['type','role']:['type']);
  if(value.type==='all')return {type:'all'};
  if(value.type==='role')return {type:'role',role:choice(value.role,['admin','member'],'公告受众角色')};
  const users=new Set(service.store.users.map(user=>user.id));
  if(value.type!=='users'||!Array.isArray(value.userIds)||!value.userIds.length||
    value.userIds.some(id=>typeof id!=='string'||!users.has(id)))fail('请选择存在的公告接收成员。');
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
  const rows=service.db.prepare(`SELECT id,revision FROM community_posts_v2 p WHERE kind='announcement' AND popup=1 AND ${audienceSQL}
    AND NOT EXISTS (SELECT 1 FROM announcement_acknowledgements_v2 a WHERE a.user_id=? AND a.post_id=p.id AND a.revision=p.revision)
    ORDER BY pinned DESC,id DESC LIMIT 10`).all(actor.role,actor.userId,actor.userId);
  return {version:1,pending:rows.map(r=>({id:String(r.id),revision:r.revision}))};
}
function prune(db,now){
  const before=now-COMMUNITY_LIMITS.retentionDays*DAY;
  db.prepare('DELETE FROM community_keys_v2 WHERE created_at<?').run(before);
  db.prepare('DELETE FROM community_chat_v2 WHERE created_at<?').run(before);
  db.prepare('DELETE FROM community_chat_v2 WHERE id <= COALESCE((SELECT id FROM community_chat_v2 ORDER BY id DESC LIMIT 1 OFFSET ?),0)').run(COMMUNITY_LIMITS.chat);
  db.prepare('DELETE FROM community_chat_images_v2 WHERE NOT EXISTS (SELECT 1 FROM community_chat_v2 c WHERE c.id=message_id)').run();
  // Disk floor: past the total, the oldest pictures go first; a picture-only message goes with its picture.
  let over=db.prepare('SELECT COALESCE(sum(size),0) AS n FROM community_chat_images_v2').get().n-COMMUNITY_LIMITS.chatImagesTotalBytes;
  if(over>0){
    const drop=db.prepare('DELETE FROM community_chat_images_v2 WHERE message_id=?');
    for(const row of db.prepare('SELECT message_id,size FROM community_chat_images_v2 ORDER BY message_id').all()){if(over<=0)break;drop.run(row.message_id);over-=row.size;}
    db.prepare("DELETE FROM community_chat_v2 WHERE body='' AND NOT EXISTS (SELECT 1 FROM community_chat_images_v2 i WHERE i.message_id=community_chat_v2.id)").run();
  }
  db.prepare('DELETE FROM community_chat_mentions_v2 WHERE NOT EXISTS (SELECT 1 FROM community_chat_v2 c WHERE c.id=message_id)').run();
}
// A picture-only message has an empty body; any text follows the usual rules.
function chatBody(value,image){return image&&(value===undefined||typeof value==='string'&&!value.trim())?'':text(value,COMMUNITY_LIMITS.chatBody,'消息');}
function chatImage(value){
  if(value===undefined)return null;
  value=selectFields(value,['type','data','width','height']);const max=COMMUNITY_LIMITS.chatImageBytes;
  if(!CHAT_IMAGE.types.includes(value.type)||typeof value.data!=='string'||value.data.length>Math.ceil(max/3)*4)fail(`图片须为 PNG、JPEG 或 WebP，且不超过 ${max/1000} KB。`);
  const data=Buffer.from(value.data,'base64');
  if(data.length>max)fail(`图片须为 PNG、JPEG 或 WebP，且不超过 ${max/1000} KB。`);
  if(!data.length||[value.width,value.height].some(side=>!Number.isInteger(side)||side<1||side>CHAT_IMAGE.maxSide))fail('图片读取失败，请重新选择。');
  return {type:value.type,data,width:value.width,height:value.height};
}
function mention(service,authorId,messageId,body){
  service.db.prepare('DELETE FROM community_chat_mentions_v2 WHERE message_id=?').run(messageId);
  const insert=service.db.prepare('INSERT INTO community_chat_mentions_v2(user_id,message_id) VALUES(?,?)');
  for(const user of mentionedUsers(body,service.store.users.filter(user=>user.enabled&&user.id!==authorId)))insert.run(user.id,messageId);
}
// Unread @mentions of this account; reading the chat clears them.
export function chatMentions(service,actor){
  return service.db.prepare('SELECT count(*) AS n FROM community_chat_mentions_v2 m JOIN community_chat_v2 c ON c.id=m.message_id WHERE m.user_id=? AND c.created_at>=?')
    .get(actor.userId,Date.now()-COMMUNITY_LIMITS.retentionDays*DAY).n;
}
export function chatImageFile(service,principal,value){
  if(!service.store.users.find(u=>u.id===principal.userId)?.enabled)fail('账号已暂停或不存在。',403);
  const row=service.db.prepare('SELECT i.type,i.data FROM community_chat_images_v2 i JOIN community_chat_v2 c ON c.id=i.message_id WHERE i.message_id=? AND c.created_at>=?')
    .get(id(value),Date.now()-COMMUNITY_LIMITS.retentionDays*DAY);
  if(!row)fail('图片不存在或已过期。',404);return row;
}
export function pruneTaskNotes(service){
  // Missing/UNKNOWN/LOST is NOT a confirmed end. General notes have no job_id
  // and intentionally survive both task cleanup and the public chat's TTL.
  const linked=service.db.prepare('SELECT DISTINCT job_id FROM community_notes_v2 WHERE job_id IS NOT NULL').all();
  if(!linked.length)return 0;
  // Reconciliation mutates memory before save(). A failed portal_state write
  // must not let its finally hook (or a community read) erase durable bodies.
  const saved=service.db.prepare('SELECT data FROM portal_state_v2 WHERE id=1').get();
  const ended=new Set((saved?JSON.parse(saved.data).jobs:[]).filter(j=>['SUCCEEDED','FAILED','CANCELED'].includes(j.state)).map(j=>j.id));
  if(!ended.size)return 0;
  const ids=linked.map(r=>r.job_id).filter(id=>ended.has(id));
  if(!ids.length)return 0;
  const db=service.db;let removed=0;db.exec('SAVEPOINT task_notes_cleanup');
  try{const del=db.prepare('DELETE FROM community_notes_v2 WHERE job_id=?');for(const id of ids)removed+=Number(del.run(id).changes);db.exec('RELEASE task_notes_cleanup');return removed;}
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
    CREATE TABLE IF NOT EXISTS community_posts_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('feedback','discussion','announcement')),
      title TEXT NOT NULL, body TEXT NOT NULL, announcement_type TEXT,
      status TEXT NOT NULL DEFAULT 'open', pinned INTEGER NOT NULL DEFAULT 0,
      audience_json TEXT NOT NULL DEFAULT '{"type":"all"}',popup INTEGER NOT NULL DEFAULT 0,appearance_json TEXT NOT NULL DEFAULT '${JSON.stringify(defaultAppearance)}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_posts_order ON community_posts_v2(pinned DESC,id DESC);
    CREATE TABLE IF NOT EXISTS community_comments_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, author_id TEXT NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_comments_post ON community_comments_v2(post_id,id);
    CREATE TABLE IF NOT EXISTS community_chat_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_chat_age ON community_chat_v2(created_at);
    CREATE TABLE IF NOT EXISTS community_chat_images_v2 (
      message_id INTEGER PRIMARY KEY, type TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      size INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_chat_mentions_v2 (
      user_id TEXT NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY(user_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS community_chat_mentions_message ON community_chat_mentions_v2(message_id);
    CREATE TABLE IF NOT EXISTS community_notes_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT, author_id TEXT NOT NULL, job_id TEXT,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS community_notes_job ON community_notes_v2(job_id);
    CREATE TABLE IF NOT EXISTS community_keys_v2 (
      author_id TEXT NOT NULL, client_key TEXT NOT NULL, operation TEXT NOT NULL,
      entity_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(author_id,client_key)
    );
    CREATE INDEX IF NOT EXISTS community_keys_age ON community_keys_v2(created_at);
  `);
  service.db.exec(`CREATE TABLE IF NOT EXISTS announcement_acknowledgements_v2 (
    user_id TEXT NOT NULL,post_id INTEGER NOT NULL,revision INTEGER NOT NULL,acknowledged_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,post_id))`);
  // Retention is also enforced on reads; this reclaims expired content at startup
  // and on writes without a background process or a full-history JSON rewrite.
  if(!service.globalMaintenanceActive?.())prune(service.db,Date.now());
  service.pruneTaskNotes=()=>pruneTaskNotes(service);
}
function create(service,actor,operation,args,type,now,insert){
  const db=service.db,clientKey=key(args.key);
  prune(db,now);
  const existing=db.prepare('SELECT * FROM community_keys_v2 WHERE author_id=? AND client_key=?').get(actor.userId,clientKey);
  if(existing){
    if(existing.operation!==operation)fail('同一 key 不能用于不同内容。',409);
    const row=get(service,type,existing.entity_id);
    return {[type]:view(service,row,actor,type),id:String(existing.entity_id),deleted:!row,duplicate:true};
  }
  const entityId=Number(insert());
  db.prepare('INSERT INTO community_keys_v2(author_id,client_key,operation,entity_id,created_at) VALUES(?,?,?,?,?)').run(actor.userId,clientKey,operation,entityId,now);
  if(type==='message')prune(db,now);
  service.audit(actor.username,operation,String(entityId),'ok');
  return {[type]:view(service,get(service,type,entityId),actor,type),duplicate:false};
}
function postCursor(value,kind,status){
  if(value===undefined)return null;
  if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))fail('分页游标无效。');
  let cursor;try{cursor=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{fail('分页游标无效。');}
  if(!cursor||![0,1].includes(cursor.p))fail('分页游标与筛选条件不匹配。');
  id(cursor.i);return cursor;
}
function listPosts(service,actor,args){
  args=selectFields(args,['kind','status','cursor','limit']);const limit=page(args.limit,50),kind=args.kind===undefined?null:choice(args.kind,KINDS,'帖子类型'),status=args.status===undefined?null:choice(args.status,STATUSES,'状态');
  const cursor=postCursor(args.cursor,kind,status),where=[],params=[];
  if(actor.role!=='admin'){where.push(`(kind!='announcement' OR ${audienceSQL})`);params.push(actor.role,actor.userId);}
  if(kind){where.push('kind=?');params.push(kind);}if(status){where.push('status=?');params.push(status);}
  if(cursor){where.push('(pinned<? OR (pinned=? AND id<?))');params.push(cursor.p,cursor.p,id(cursor.i));}
  const rows=service.db.prepare(`SELECT * FROM community_posts_v2 ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY pinned DESC,id DESC LIMIT ?`).all(...params,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);
  const last=rows.at(-1);return {posts:rows.map(r=>view(service,r,actor,'post')),nextCursor:more?Buffer.from(JSON.stringify({v:1,k:kind,s:status,p:last.pinned,i:String(last.id)})).toString('base64url'):null};
}
function listComments(service,actor,args){
  args=selectFields(args,['postId','cursor','limit']);const post=readablePost(service,actor,args.postId),limit=page(args.limit),cursor=args.cursor===undefined?0:id(args.cursor);
  const rows=service.db.prepare('SELECT * FROM community_comments_v2 WHERE post_id=? AND id>? ORDER BY id LIMIT ?').all(post.id,cursor,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);
  return {comments:rows.map(r=>view(service,r,actor,'comment')),nextCursor:more?String(rows.at(-1).id):null};
}
function listChat(service,actor,args,now){
  args=selectFields(args,['before','after','limit']);if(args.before!==undefined&&args.after!==undefined)fail('before 与 after 不能同时指定。');
  const limit=page(args.limit),after=args.after===undefined?null:id(args.after),before=args.before===undefined?null:id(args.before),cutoff=now-COMMUNITY_LIMITS.retentionDays*DAY;
  const where=['created_at>=?'],params=[cutoff];if(after!==null){where.push('id>?');params.push(after);}if(before!==null){where.push('id<?');params.push(before);}
  const rows=service.db.prepare(`SELECT * FROM community_chat_v2 WHERE ${where.join(' AND ')} ORDER BY id ${after!==null?'ASC':'DESC'} LIMIT ?`).all(...params,limit+1),more=rows.length>limit;rows.length=Math.min(rows.length,limit);if(after===null)rows.reverse();
  const latest=service.db.prepare('SELECT max(id) AS id FROM community_chat_v2 WHERE created_at>=?').get(cutoff).id;
  return {messages:rows.map(r=>view(service,r,actor,'message')),nextCursor:rows.length?String(after!==null?rows.at(-1).id:rows[0].id):null,latestCursor:latest===null?null:String(latest),hasMore:more};
}
function change(service,actor,operation,args,type,remove,now){
  args=selectFields(args,remove?['id','revision']:type==='post'?['id','revision','title','body','status','pinned','announcementType','audience','popup','appearance']:['id','revision','body']);
  const row=required(service,type,args.id),image=type==='message'&&!!service.db.prepare('SELECT 1 FROM community_chat_images_v2 WHERE message_id=?').get(row.id);
  if(type==='post')readablePost(service,actor,args.id);
  if(type==='comment')readablePost(service,actor,String(row.post_id));
  if(remove&&row.kind==='announcement')admin(actor);
  if(!remove){
    if(type==='post'&&['status','pinned','announcementType'].some(k=>Object.hasOwn(args,k)))admin(actor);
    if(type==='post'&&row.kind==='announcement')admin(actor);
  }
  if(remove){
    if(type==='post'){service.db.prepare('DELETE FROM community_comments_v2 WHERE post_id=?').run(row.id);service.db.prepare('DELETE FROM announcement_acknowledgements_v2 WHERE post_id=?').run(row.id);}
    service.db.prepare(`DELETE FROM ${tables[type]} WHERE id=?`).run(row.id);
    if(type==='message')for(const table of ['community_chat_images_v2','community_chat_mentions_v2'])service.db.prepare(`DELETE FROM ${table} WHERE message_id=?`).run(row.id);
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
    service.db.prepare('UPDATE community_posts_v2 SET title=?,body=?,status=?,pinned=?,announcement_type=?,audience_json=?,popup=?,appearance_json=?,updated_at=?,revision=revision+1 WHERE id=?').run(title,body,status,args.pinned===undefined?row.pinned:Number(args.pinned),announcementType,JSON.stringify(audience),popup,style,now,row.id);
  }else{
    const body=type==='message'?chatBody(args.body,image):text(args.body,COMMUNITY_LIMITS[type==='comment'?'commentBody':'chatBody'],'正文');
    service.db.prepare(`UPDATE ${tables[type]} SET body=?,updated_at=?,revision=revision+1 WHERE id=?`).run(body,now,row.id);
    if(type==='message')mention(service,row.author_id,row.id,body);
  }
  service.audit(actor.username,operation,String(row.id),'ok');return {[type]:view(service,get(service,type,row.id),actor,type)};
}
function dispatch(service,actor,operation,args,now){
  const db=service.db;
  if(operation==='community.announcements.pending'){
    args=selectFields(args,[]);return {posts:announcementState(service,actor).pending.map(p=>view(service,required(service,'post',p.id),actor,'post'))};
  }
  if(operation==='community.announcements.ack'){
    args=selectFields(args,['id','revision']);const row=readablePost(service,actor,args.id);
    if(!Number.isSafeInteger(args.revision)||args.revision<1)fail('公告版本无效。');
    if(row.kind!=='announcement'||!receives(row,actor))fail('公告不面向当前账号。',404);
    db.prepare(`INSERT INTO announcement_acknowledgements_v2(user_id,post_id,revision,acknowledged_at) VALUES(?,?,?,?)
      ON CONFLICT(user_id,post_id) DO UPDATE SET revision=excluded.revision,acknowledged_at=excluded.acknowledged_at`).run(actor.userId,row.id,args.revision,now);
    return {acknowledged:true,id:String(row.id),revision:args.revision,announcements:announcementState(service,actor)};
  }
  if(operation==='community.notes.get'){args=selectFields(args,['id']);return {note:view(service,required(service,'note',args.id),actor,'note')};}
  if(operation==='community.notes.list'){
    args=selectFields(args,['before','limit']);const limit=page(args.limit),before=args.before===undefined?null:id(args.before);
    const rows=db.prepare('SELECT * FROM community_notes_v2'+(before===null?'':' WHERE id<?')+' ORDER BY id DESC LIMIT ?').all(...(before===null?[]:[before]),limit+1);
    const more=rows.length>limit;rows.length=Math.min(rows.length,limit);
    return {notes:rows.map(row=>view(service,row,actor,'note')),nextCursor:more?String(rows.at(-1).id):null};
  }
  if(operation==='community.notes.create'){
    args=selectFields(args,['key','body','jobId']);const body=text(args.body,COMMUNITY_LIMITS.chatBody,'留言'),jobId=args.jobId??null;
    if(jobId!==null&&(typeof jobId!=='string'||!jobId||jobId.length>128))fail('任务 ID 无效。');
    const task=jobId===null?null:service.store.jobs.find(j=>j.id===jobId);
    if(jobId!==null&&!task)fail('任务不存在。',404);
    return create(service,actor,operation,args,'note',now,()=>{
      // Check after deduplication: an uncertain retry after cleanup must return
      // the old deleted receipt, never resurrect a completed task's message.
      if(task&&['SUCCEEDED','FAILED','CANCELED'].includes(task.state))fail('任务已结束；长期通知请使用非任务留言。',409);
      return db.prepare('INSERT INTO community_notes_v2(author_id,job_id,body,created_at,updated_at) VALUES(?,?,?,?,?)').run(actor.userId,jobId,body,now,now).lastInsertRowid;
    });
  }
  if(operation==='community.info'){args=selectFields(args,[]);return {enabled:true,version:2,limits:{...COMMUNITY_LIMITS,titleBytes:COMMUNITY_LIMITS.title*3,postBodyBytes:COMMUNITY_LIMITS.postBody*3,commentBodyBytes:COMMUNITY_LIMITS.commentBody*3,chatBodyBytes:COMMUNITY_LIMITS.chatBody*3},capabilities:['posts','announcements','comments','chat','idempotency-30d','announcement-publish-v1','task-notes-v1','chat-images-v1','chat-mentions-v1']};}
  if(operation==='community.posts.list')return listPosts(service,actor,args);
  if(operation==='community.posts.get'){args=selectFields(args,['id']);return {post:view(service,readablePost(service,actor,args.id),actor,'post')};}
  if(operation==='community.comments.list')return listComments(service,actor,args);
  if(operation==='community.chat.list')return listChat(service,actor,args,now);
  if(operation==='community.posts.create'){
    args=selectFields(args,['key','kind','title','body','announcementType','pinned','audience','popup','appearance']);const kind=choice(args.kind,KINDS,'帖子类型');
    if(kind==='announcement')admin(actor);else if(['announcementType','pinned','audience','popup','appearance'].some(k=>args[k]!==undefined))fail('只有管理员公告可设置公告类型、受众、弹窗或外观。');
    if(args.pinned!==undefined&&typeof args.pinned!=='boolean')fail('pinned 必须为布尔值。');
    if(args.popup!==undefined&&typeof args.popup!=='boolean')fail('弹窗设置无效。');
    const audience=normalizeAudience(service,args.audience),popup=args.popup===true;
    const style=appearance(args.appearance);
    const title=text(args.title,COMMUNITY_LIMITS.title,'标题'),body=text(args.body,COMMUNITY_LIMITS.postBody,'正文'),announcementType=kind==='announcement'?choice(args.announcementType??'notice',ANNOUNCEMENTS,'公告类型'):null;
    return create(service,actor,operation,args,'post',now,()=>{
      return db.prepare('INSERT INTO community_posts_v2(author_id,kind,title,body,announcement_type,pinned,audience_json,popup,appearance_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(actor.userId,kind,title,body,announcementType,Number(args.pinned===true),JSON.stringify(audience),Number(popup),JSON.stringify(style),now,now).lastInsertRowid;
    });
  }
  if(operation==='community.comments.create'){
    args=selectFields(args,['key','postId','body']);const postId=id(args.postId),body=text(args.body,COMMUNITY_LIMITS.commentBody,'评论');
    if(get(service,'post',postId))readablePost(service,actor,args.postId);
    // Validate parent inside insert: a retry after deletion must return a durable
    // deleted receipt instead of re-creating content or losing idempotency.
    return create(service,actor,operation,args,'comment',now,()=>{readablePost(service,actor,args.postId);return db.prepare('INSERT INTO community_comments_v2(post_id,author_id,body,created_at,updated_at) VALUES(?,?,?,?,?)').run(postId,actor.userId,body,now,now).lastInsertRowid;});
  }
  if(operation==='community.chat.send'){
    args=selectFields(args,['key','body','image']);const image=chatImage(args.image),body=chatBody(args.body,image);
    return create(service,actor,operation,args,'message',now,()=>{
      const messageId=db.prepare('INSERT INTO community_chat_v2(author_id,body,created_at,updated_at) VALUES(?,?,?,?)').run(actor.userId,body,now,now).lastInsertRowid;
      if(image)db.prepare('INSERT INTO community_chat_images_v2(message_id,type,width,height,size,data) VALUES(?,?,?,?,?,?)').run(messageId,image.type,image.width,image.height,image.data.length,image.data);
      mention(service,actor.userId,messageId,body);return messageId;
    });
  }
  if(operation==='community.chat.read'){
    args=selectFields(args,['id']);db.prepare('DELETE FROM community_chat_mentions_v2 WHERE user_id=? AND message_id<=?').run(actor.userId,id(args.id));
    return {chatMentions:chatMentions(service,actor)};
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
  const now=Date.now();service.db.exec('BEGIN IMMEDIATE');
  try{pruneTaskNotes(service);const result=dispatch(service,principal,operation,args,now);service.db.exec('COMMIT');return {...result,serverTime:nowISO(now)};}
  catch(error){service.db.exec('ROLLBACK');throw error;}
}
