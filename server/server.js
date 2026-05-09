// server/server.js — Astro Core Server
'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const mysql2 = require('mysql2/promise');
const { WebSocketServer } = require('ws');
const { PeerServer } = require('peerjs-server');

const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config', 'astro.json');

let CFG;
function loadConfig() { CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
loadConfig();

let pool;
async function getPool() {
  if (!pool) {
    pool = mysql2.createPool({
      host: CFG.mysql.host, port: CFG.mysql.port,
      user: CFG.mysql.user, password: CFG.mysql.password,
      database: CFG.mysql.database,
      waitForConnections: true, connectionLimit: 20, queueLimit: 0
    });
  }
  return pool;
}

const log = (level, msg, data) => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  fs.appendFileSync(path.join(ROOT, 'logs', 'server.log'), line + '\n');
};

// profanity filter — allows hell/damn/shit/fuck, blocks slurs
const BLOCKED = [
  /\bn+[i1]+g+[aoe]+r+s?\b/gi,/\bn+[i1]+g+s?\b/gi,/\bk+[i1]+k+e+s?\b/gi,
  /\bc+h+[i1]+n+k+s?\b/gi,/\bs+p+[i1]+c+k?s?\b/gi,/\bw+e+t+b+a+c+k+s?\b/gi,
  /\bc+[o0]+[o0]+n+s?\b/gi,/\bj+[i1]+g+a+b+[o0]+[o0]+s?\b/gi,
  /\bt+[o0]+w+e+l+h+e+a+d+s?\b/gi,/\bs+a+n+d+n+[i1]+g+g+e+r+s?\b/gi,
  /\bf+a+g+g*[o0]+t+s?\b/gi,/\bf+[a4]+g+s?\b/gi,/\bd+[y1]+k+e+s?\b/gi,
  /\bt+r+[a4]+n+n+[y1]+s?\b/gi,/\br+[e3]+t+[a4]+r+d+s?\b/gi,
];
function hasSlur(t) { return BLOCKED.some(p => { p.lastIndex=0; return p.test(t); }); }

function encryptTag(projectId) {
  const key = Buffer.from(CFG.tagEncryptionKey, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({projectId,ts:Date.now()}),'utf8'),cipher.final()]);
  return iv.toString('hex')+':'+enc.toString('hex');
}

function decryptTag(tag) {
  try {
    const key = Buffer.from(CFG.tagEncryptionKey, 'hex');
    const [ivH,dH] = tag.split(':');
    const dec = crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(ivH,'hex'));
    return JSON.parse(Buffer.concat([dec.update(Buffer.from(dH,'hex')),dec.final()]).toString('utf8'));
  } catch { return null; }
}

function tagHash(id) { return crypto.createHmac('sha256',CFG.masterSecret).update(id).digest('hex'); }
function signToken(p,e='7d') { return jwt.sign(p,CFG.jwtSecret,{expiresIn:e}); }
function verifyToken(t) { try{return jwt.verify(t,CFG.jwtSecret);}catch{return null;} }

const app = express();
app.use(cors({origin:'*',methods:['GET','POST','PUT','DELETE','OPTIONS']}));
app.use(express.json({limit:'20mb'}));
// Serve Next.js dashboard if built, otherwise fall back to legacy public/
const dashboardOut = path.join(ROOT,'dashboard','out');
if (fs.existsSync(dashboardOut)) {
  app.use(express.static(dashboardOut));
  app.get('/', (req,res) => res.sendFile(path.join(dashboardOut,'index.html')));
} else {
  app.use(express.static(path.join(ROOT,'public')));
};

function authRequired(req,res,next) {
  const h=req.headers.authorization;
  if(!h?.startsWith('Bearer ')) return res.status(401).json({error:'Unauthorized'});
  const tok=verifyToken(h.slice(7));
  if(!tok) return res.status(401).json({error:'Invalid token'});
  req.user=tok; next();
}

function adminRequired(req,res,next) {
  authRequired(req,res,()=>{ if(req.user.role!=='admin') return res.status(403).json({error:'Admin required'}); next(); });
}

async function validateTag(req,res,next) {
  const tag=req.headers['x-astro-tag']||req.headers['x-form-tag']||req.query.tag;
  if(!tag) return res.status(403).json({error:'No project tag'});
  const decoded=decryptTag(tag);
  if(!decoded) return res.status(403).json({error:'Invalid tag'});
  try {
    const db=await getPool();
    const hash=tagHash(decoded.projectId);
    const [rows]=await db.execute('SELECT * FROM projects WHERE id=? AND tag_hash=? AND status=?',[decoded.projectId,hash,'approved']);
    if(!rows.length) return res.status(403).json({error:'Tag not approved'});
    req.project=rows[0]; req.projectId=decoded.projectId; next();
  } catch(err) { log('ERROR','Tag validation',{err:err.message}); res.status(500).json({error:'Internal error'}); }
}

function tagAndAuth(req,res,next) { validateTag(req,res,()=>authRequired(req,res,next)); }

// ── dashboard auth
app.post('/api/auth/login', async(req,res)=>{
  const{username,password,projectId='__astro__'}=req.body;
  if(!username||!password) return res.status(400).json({error:'Missing fields'});
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM users WHERE project_id=? AND username=?',[projectId,username]);
    if(!rows.length) return res.status(401).json({error:'Invalid credentials'});
    const user=rows[0];
    if(!await bcrypt.compare(password,user.password_hash)) return res.status(401).json({error:'Invalid credentials'});
    await db.execute('UPDATE users SET last_login=NOW() WHERE id=?',[user.id]);
    const token=signToken({userId:user.id,username:user.username,role:user.role,projectId});
    res.json({token,user:{id:user.id,username:user.username,role:user.role}});
  }catch(err){log('ERROR','Login',{err:err.message});res.status(500).json({error:'Internal error'});}
});

// ── projects
app.get('/api/projects',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT id,name,description,status,created_at,updated_at,metadata FROM projects WHERE id!=?',['__astro__']);
    const[peers]=await db.execute('SELECT project_id,COUNT(*) as count FROM peers WHERE last_seen>DATE_SUB(NOW(),INTERVAL 5 MINUTE) GROUP BY project_id');
    const pm={};peers.forEach(p=>{pm[p.project_id]=p.count;});
    res.json(rows.map(r=>({...r,activePeers:pm[r.id]||0})));
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/projects',adminRequired,async(req,res)=>{
  const{name,description,metadata}=req.body;
  if(!name) return res.status(400).json({error:'Name required'});
  try{
    const db=await getPool();
    const id=crypto.randomUUID().replace(/-/g,'').substring(0,16);
    const encTag=encryptTag(id);const hash=tagHash(id);
    await db.execute('INSERT INTO projects(id,name,description,tag_encrypted,tag_hash,status,metadata)VALUES(?,?,?,?,?,?,?)',[id,name,description||'',encTag,hash,'pending',JSON.stringify(metadata||{})]);
    log('INFO','Project created',{id,name});res.json({id,name,tag:encTag,status:'pending'});
  }catch(err){res.status(500).json({error:err.message});}
});

app.put('/api/projects/:id/status',adminRequired,async(req,res)=>{
  const{status}=req.body;
  if(!['approved','pending','revoked'].includes(status)) return res.status(400).json({error:'Invalid status'});
  try{const db=await getPool();await db.execute('UPDATE projects SET status=? WHERE id=?',[status,req.params.id]);log('INFO','Project status updated',{id:req.params.id,status});res.json({ok:true});}
  catch(err){res.status(500).json({error:err.message});}
});

app.delete('/api/projects/:id',adminRequired,async(req,res)=>{
  try{const db=await getPool();await db.execute('DELETE FROM projects WHERE id=? AND id!=?',[req.params.id,'__astro__']);res.json({ok:true});}
  catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/projects/:id/tag',adminRequired,async(req,res)=>{
  try{const db=await getPool();const[rows]=await db.execute('SELECT tag_encrypted FROM projects WHERE id=?',[req.params.id]);if(!rows.length)return res.status(404).json({error:'Not found'});res.json({tag:rows[0].tag_encrypted});}
  catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/projects/:id/module',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();const[rows]=await db.execute('SELECT * FROM projects WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    loadConfig();const mod=generateModule(rows[0].tag_encrypted,CFG.network.publicIP,CFG.ports);
    res.setHeader('Content-Type','application/javascript');res.setHeader('Content-Disposition',`attachment; filename="astro-sdk-${req.params.id}.js"`);res.send(mod);
  }catch(err){res.status(500).json({error:err.message});}
});

// ── user auth
app.post('/api/users/register',validateTag,async(req,res)=>{
  const{username,password,email}=req.body;
  if(!username||!password) return res.status(400).json({error:'Missing fields'});
  try{
    const db=await getPool();
    const[ex]=await db.execute('SELECT id FROM users WHERE project_id=? AND username=?',[req.projectId,username]);
    if(ex.length) return res.status(409).json({error:'Username taken'});
    const hash=await bcrypt.hash(password,12);const id=crypto.randomUUID();
    await db.execute('INSERT INTO users(id,project_id,username,email,password_hash,role)VALUES(?,?,?,?,?,?)',[id,req.projectId,username,email||null,hash,'user']);
    const token=signToken({userId:id,username,role:'user',projectId:req.projectId});
    res.json({token,user:{id,username,role:'user'}});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/users/login',validateTag,async(req,res)=>{
  const{username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'Missing fields'});
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM users WHERE project_id=? AND username=?',[req.projectId,username]);
    if(!rows.length) return res.status(401).json({error:'Invalid credentials'});
    const user=rows[0];
    if(!await bcrypt.compare(password,user.password_hash)) return res.status(401).json({error:'Invalid credentials'});
    await db.execute('UPDATE users SET last_login=NOW() WHERE id=?',[user.id]);
    const token=signToken({userId:user.id,username:user.username,role:user.role,projectId:req.projectId});
    res.json({token,user:{id:user.id,username:user.username,role:user.role}});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/users/search',validateTag,authRequired,async(req,res)=>{
  const{q}=req.query;if(!q)return res.json([]);
  try{const db=await getPool();const[rows]=await db.execute('SELECT id,username FROM users WHERE project_id=? AND username LIKE ? AND id!=? LIMIT 10',[req.projectId,`%${q}%`,req.user.userId]);res.json(rows);}
  catch(err){res.status(500).json({error:err.message});}
});

// ── conversations
app.get('/api/conversations',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(
      `SELECT c.*,
        (SELECT content FROM messages m WHERE m.conversation_id=c.id AND m.flagged_hidden=0 ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT sender_name FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) as last_sender,
        (SELECT created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) as last_message_at
       FROM conversations c WHERE c.project_id=? AND JSON_CONTAINS(c.members,JSON_QUOTE(?))
       ORDER BY last_message_at DESC`,
      [req.projectId,req.user.userId]
    );
    res.json(rows.map(r=>({...r,members:typeof r.members==='string'?JSON.parse(r.members):r.members})));
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/conversations',validateTag,authRequired,async(req,res)=>{
  const{type,name,memberIds}=req.body;
  if(!type||!memberIds?.length) return res.status(400).json({error:'Missing fields'});
  try{
    const db=await getPool();
    const all=[...new Set([req.user.userId,...memberIds])];
    if(type==='dm'&&all.length===2){
      const[ex]=await db.execute(`SELECT * FROM conversations WHERE project_id=? AND type='dm' AND JSON_CONTAINS(members,JSON_QUOTE(?)) AND JSON_CONTAINS(members,JSON_QUOTE(?))`,[req.projectId,all[0],all[1]]);
      if(ex.length){const e=ex[0];return res.json({...e,members:typeof e.members==='string'?JSON.parse(e.members):e.members});}
    }
    const id=crypto.randomUUID();
    await db.execute('INSERT INTO conversations(id,project_id,type,name,created_by,members)VALUES(?,?,?,?,?,?)',[id,req.projectId,type,name||null,req.user.userId,JSON.stringify(all)]);
    res.json({id,type,name,members:all,created_by:req.user.userId});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/conversations/:id/members',validateTag,authRequired,async(req,res)=>{
  const{userId}=req.body;
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM conversations WHERE id=? AND project_id=?',[req.params.id,req.projectId]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const members=typeof rows[0].members==='string'?JSON.parse(rows[0].members):rows[0].members;
    if(!members.includes(req.user.userId))return res.status(403).json({error:'Not a member'});
    if(!members.includes(userId))members.push(userId);
    await db.execute('UPDATE conversations SET members=? WHERE id=?',[JSON.stringify(members),req.params.id]);
    res.json({ok:true,members});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── messages
app.get('/api/conversations/:id/messages',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[conv]=await db.execute('SELECT members FROM conversations WHERE id=? AND project_id=?',[req.params.id,req.projectId]);
    if(!conv.length)return res.status(404).json({error:'Not found'});
    const members=typeof conv[0].members==='string'?JSON.parse(conv[0].members):conv[0].members;
    if(!members.includes(req.user.userId))return res.status(403).json({error:'Not a member'});
    const lim=parseInt(req.query.limit,10)||50;
    const off=parseInt(req.query.offset,10)||0;
    const[rows]=await db.execute(`SELECT * FROM messages WHERE conversation_id=? AND flagged_hidden=0 ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`,[req.params.id]);
    // mark read
    try{await db.execute(`UPDATE messages SET read_by=JSON_ARRAY_APPEND(COALESCE(read_by,JSON_ARRAY()),'$',?) WHERE conversation_id=? AND NOT JSON_CONTAINS(COALESCE(read_by,JSON_ARRAY()),JSON_QUOTE(?))`,[req.user.userId,req.params.id,req.user.userId]);}catch{}
    res.json(rows.reverse().map(r=>({...r,read_by:typeof r.read_by==='string'?JSON.parse(r.read_by||'[]'):(r.read_by||[]),reactions:typeof r.reactions==='string'?JSON.parse(r.reactions||'{}'):(r.reactions||{})})));
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/conversations/:id/messages',validateTag,authRequired,async(req,res)=>{
  const{content,type='text'}=req.body;
  if(!content)return res.status(400).json({error:'No content'});
  if(hasSlur(content)){
    try{
      const db=await getPool();const id=crypto.randomUUID();
      await db.execute('INSERT INTO messages(id,conversation_id,sender_id,sender_name,content,type,read_by,reactions,flagged,flagged_hidden,flag_reason)VALUES(?,?,?,?,?,?,?,?,1,1,?)',[id,req.params.id,req.user.userId,req.user.username,content,type,JSON.stringify([req.user.userId]),JSON.stringify({}),'slur']);
      await db.execute('INSERT INTO flagged_content(id,project_id,content_type,content_id,reason)VALUES(?,?,?,?,?)',[crypto.randomUUID(),req.projectId,'message',id,'slur']);
    }catch{}
    return res.json({ok:true,flagged:true,message:'Your message was flagged and not delivered.'});
  }
  try{
    const db=await getPool();
    const[conv]=await db.execute('SELECT members FROM conversations WHERE id=? AND project_id=?',[req.params.id,req.projectId]);
    if(!conv.length)return res.status(404).json({error:'Not found'});
    const members=typeof conv[0].members==='string'?JSON.parse(conv[0].members):conv[0].members;
    if(!members.includes(req.user.userId))return res.status(403).json({error:'Not a member'});
    const id=crypto.randomUUID();const readBy=[req.user.userId];
    await db.execute('INSERT INTO messages(id,conversation_id,sender_id,sender_name,content,type,read_by,reactions,flagged,flagged_hidden)VALUES(?,?,?,?,?,?,?,?,0,0)',[id,req.params.id,req.user.userId,req.user.username,content,type,JSON.stringify(readBy),JSON.stringify({})]);
    const message={id,conversation_id:req.params.id,sender_id:req.user.userId,sender_name:req.user.username,content,type,read_by:readBy,reactions:{},created_at:new Date().toISOString()};
    broadcastToUsers(req.projectId,members,{type:'message:new',conversationId:req.params.id,message});
    res.json({ok:true,message});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/messages/:id/react',validateTag,authRequired,async(req,res)=>{
  const{emoji}=req.body;if(!emoji)return res.status(400).json({error:'No emoji'});
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM messages WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const reactions=typeof rows[0].reactions==='string'?JSON.parse(rows[0].reactions||'{}'):(rows[0].reactions||{});
    if(!reactions[emoji])reactions[emoji]=[];
    const idx=reactions[emoji].indexOf(req.user.userId);
    if(idx>-1)reactions[emoji].splice(idx,1);else reactions[emoji].push(req.user.userId);
    if(!reactions[emoji].length)delete reactions[emoji];
    await db.execute('UPDATE messages SET reactions=? WHERE id=?',[JSON.stringify(reactions),req.params.id]);
    res.json({ok:true,reactions});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── spaces
app.get('/api/spaces',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(`SELECT s.*,(SELECT COUNT(*) FROM space_members sm WHERE sm.space_id=s.id) as member_count FROM spaces s WHERE s.project_id=? AND s.private=0 ORDER BY member_count DESC,s.created_at DESC LIMIT 50`,[req.projectId]);
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/spaces/mine',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(`SELECT s.* FROM spaces s INNER JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=? WHERE s.project_id=? ORDER BY s.created_at DESC`,[req.user.userId,req.projectId]);
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/spaces',validateTag,authRequired,async(req,res)=>{
  const{name,description,color,private:priv}=req.body;
  if(!name)return res.status(400).json({error:'Name required'});
  try{
    const db=await getPool();const id=crypto.randomUUID();
    const invite=priv?crypto.randomBytes(4).toString('hex').toUpperCase():null;
    await db.execute('INSERT INTO spaces(id,project_id,name,description,owner_id,color,private,invite_code)VALUES(?,?,?,?,?,?,?,?)',[id,req.projectId,name,description||'',req.user.userId,color||'#888888',priv?1:0,invite]);
    await db.execute('INSERT INTO space_members(space_id,user_id,role)VALUES(?,?,?)',[id,req.user.userId,'owner']);
    res.json({id,name,description,owner_id:req.user.userId,color,private:priv,invite_code:invite});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/spaces/:id/join',validateTag,authRequired,async(req,res)=>{
  const{inviteCode}=req.body;
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM spaces WHERE id=? AND project_id=?',[req.params.id,req.projectId]);
    if(!rows.length)return res.status(404).json({error:'Space not found'});
    if(rows[0].private&&rows[0].invite_code!==inviteCode)return res.status(403).json({error:'Invalid invite code'});
    await db.execute('INSERT IGNORE INTO space_members(space_id,user_id,role)VALUES(?,?,?)',[req.params.id,req.user.userId,'member']);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

app.delete('/api/spaces/:id/leave',validateTag,authRequired,async(req,res)=>{
  try{const db=await getPool();await db.execute('DELETE FROM space_members WHERE space_id=? AND user_id=?',[req.params.id,req.user.userId]);res.json({ok:true});}
  catch(err){res.status(500).json({error:err.message});}
});

// ── space posts
app.get('/api/spaces/:id/posts',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const t=req.query.type||'board';const lim=parseInt(req.query.limit,10)||30;
    const[rows]=await db.execute(`SELECT * FROM space_posts WHERE space_id=? AND type=? AND flagged_hidden=0 ORDER BY created_at DESC LIMIT ${lim}`,[req.params.id,t]);
    res.json(rows.map(r=>({...r,flames:typeof r.flames==='string'?JSON.parse(r.flames||'[]'):(r.flames||[])})));
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/spaces/:id/posts',validateTag,authRequired,async(req,res)=>{
  const{content,type='stream',image}=req.body;
  if(!content)return res.status(400).json({error:'No content'});
  if(hasSlur(content)){
    try{
      const db=await getPool();const id=crypto.randomUUID();
      await db.execute('INSERT INTO space_posts(id,space_id,author_id,author_name,content,type,flames,flagged,flagged_hidden,flag_reason)VALUES(?,?,?,?,?,?,?,1,1,?)',[id,req.params.id,req.user.userId,req.user.username,content,type,JSON.stringify([]),'slur']);
      await db.execute('INSERT INTO flagged_content(id,project_id,content_type,content_id,reason)VALUES(?,?,?,?,?)',[crypto.randomUUID(),req.projectId,'space_post',id,'slur']);
    }catch{}
    return res.json({ok:true,flagged:true,message:'Your post was flagged.'});
  }
  try{
    const db=await getPool();
    const[space]=await db.execute('SELECT * FROM spaces WHERE id=? AND project_id=?',[req.params.id,req.projectId]);
    if(!space.length)return res.status(404).json({error:'Space not found'});
    const id=crypto.randomUUID();
    await db.execute('INSERT INTO space_posts(id,space_id,author_id,author_name,content,type,image,flames,flagged,flagged_hidden)VALUES(?,?,?,?,?,?,?,?,0,0)',[id,req.params.id,req.user.userId,req.user.username,content,type,image||null,JSON.stringify([])]);
    const post={id,space_id:req.params.id,author_id:req.user.userId,author_name:req.user.username,content,type,image:image||null,flames:[],created_at:new Date().toISOString()};
    broadcastToSpace(req.projectId,req.params.id,{type:'space:post',spaceId:req.params.id,post});
    res.json({ok:true,post});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/spaces/posts/:id/flame',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM space_posts WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const flames=typeof rows[0].flames==='string'?JSON.parse(rows[0].flames||'[]'):(rows[0].flames||[]);
    const idx=flames.indexOf(req.user.userId);
    if(idx>-1)flames.splice(idx,1);else flames.push(req.user.userId);
    await db.execute('UPDATE space_posts SET flames=? WHERE id=?',[JSON.stringify(flames),req.params.id]);
    res.json({ok:true,flames});
  }catch(err){res.status(500).json({error:err.message});}
});

app.delete('/api/spaces/posts/:id',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM space_posts WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const[space]=await db.execute('SELECT owner_id FROM spaces WHERE id=?',[rows[0].space_id]);
    const ok=rows[0].author_id===req.user.userId||(space.length&&space[0].owner_id===req.user.userId)||req.user.role==='admin';
    if(!ok)return res.status(403).json({error:'Not allowed'});
    await db.execute('DELETE FROM space_posts WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── presence
app.get('/api/presence',validateTag,async(req,res)=>{
  try{const db=await getPool();const[rows]=await db.execute("SELECT user_id,status FROM user_presence WHERE project_id=? AND last_seen>DATE_SUB(NOW(),INTERVAL 2 MINUTE)",[req.projectId]);res.json(rows);}
  catch(err){res.status(500).json({error:err.message});}
});

// ── moderation
app.get('/api/flags',adminRequired,async(req,res)=>{
  try{const db=await getPool();const[rows]=await db.execute('SELECT * FROM flagged_content WHERE reviewed=0 ORDER BY created_at DESC LIMIT 50');res.json(rows);}
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/flags/:id/dismiss',adminRequired,async(req,res)=>{
  try{const db=await getPool();await db.execute('UPDATE flagged_content SET reviewed=1 WHERE id=?',[req.params.id]);res.json({ok:true});}
  catch(err){res.status(500).json({error:err.message});}
});
app.post('/api/flags/:id/remove',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM flagged_content WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const f=rows[0];
    if(f.content_type==='message')await db.execute('UPDATE messages SET flagged_hidden=1 WHERE id=?',[f.content_id]);
    if(f.content_type==='space_post')await db.execute('UPDATE space_posts SET flagged_hidden=1 WHERE id=?',[f.content_id]);
    await db.execute('UPDATE flagged_content SET reviewed=1 WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── generic data store
app.get('/api/data/:collection',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const{limit=100,offset=0,orderBy='updated_at',order='DESC'}=req.query;
    const sO=['ASC','DESC'].includes(order.toUpperCase())?order.toUpperCase():'DESC';
    const sOB=['created_at','updated_at','doc_id'].includes(orderBy)?orderBy:'updated_at';
    const lim=parseInt(limit,10)||100;const off=parseInt(offset,10)||0;
    const[rows]=await db.execute(`SELECT doc_id,data,created_at,updated_at,created_by FROM data_store WHERE project_id=? AND collection=? ORDER BY ${sOB} ${sO} LIMIT ${lim} OFFSET ${off}`,[req.projectId,req.params.collection]);
    res.json(rows.map(r=>{const d=typeof r.data==='string'?JSON.parse(r.data||'{}'):(r.data||{});return{id:r.doc_id,...d,_meta:{createdAt:r.created_at,updatedAt:r.updated_at,createdBy:r.created_by}};}));
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/data/:collection/:docId',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM data_store WHERE project_id=? AND collection=? AND doc_id=?',[req.projectId,req.params.collection,req.params.docId]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    const r=rows[0];const d=typeof r.data==='string'?JSON.parse(r.data||'{}'):(r.data||{});
    res.json({id:r.doc_id,...d,_meta:{createdAt:r.created_at,updatedAt:r.updated_at}});
  }catch(err){res.status(500).json({error:err.message});}
});

app.put('/api/data/:collection/:docId',validateTag,async(req,res)=>{
  try{
    const db=await getPool();const{_meta,id,...data}=req.body;
    await db.execute(`INSERT INTO data_store(project_id,collection,doc_id,data,created_by)VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data)`,[req.projectId,req.params.collection,req.params.docId,JSON.stringify(data),req.body._createdBy||null]);
    broadcastToProject(req.projectId,{type:'data:update',collection:req.params.collection,docId:req.params.docId,data});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

app.delete('/api/data/:collection/:docId',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    await db.execute('DELETE FROM data_store WHERE project_id=? AND collection=? AND doc_id=?',[req.projectId,req.params.collection,req.params.docId]);
    broadcastToProject(req.projectId,{type:'data:delete',collection:req.params.collection,docId:req.params.docId});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});


// ── CDN static serve ────────────────────────────────────────────────────
const cdnPath = path.join(ROOT,'data','cdn');
fs.mkdirSync(cdnPath,{recursive:true});
app.use('/cdn',express.static(cdnPath,{maxAge:'7d',etag:true}));

// ── games ───────────────────────────────────────────────────────────────
// Public: list published games
app.get('/api/games',async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM games WHERE published=1 ORDER BY sort_order ASC, title ASC');
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

// Public: single game by slug
app.get('/api/games/:slug',async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM games WHERE slug=? AND published=1',[req.params.slug]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: list all games (including unpublished)
app.get('/api/admin/games',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM games ORDER BY sort_order ASC, title ASC');
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: create game
app.post('/api/admin/games',adminRequired,async(req,res)=>{
  const{title,slug,description,genre,cover_url,banner_url,launch_url,asset_size,price,is_free,sort_order,published}=req.body;
  if(!title||!slug)return res.status(400).json({error:'title and slug required'});
  try{
    const db=await getPool();
    const[ex]=await db.execute('SELECT id FROM games WHERE slug=?',[slug]);
    if(ex.length)return res.status(409).json({error:'Slug already exists'});
    if((await db.execute('SELECT COUNT(*) as c FROM games'))[0][0].c>=100)
      return res.status(400).json({error:'Game limit (100) reached'});
    const id=crypto.randomUUID();
    await db.execute(
      `INSERT INTO games(id,title,slug,description,genre,cover_url,banner_url,launch_url,asset_size,price,is_free,sort_order,published)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,title,slug,description||'',genre||'',cover_url||'',banner_url||'',launch_url||'',asset_size||'',Number(price)||0,is_free!==false?1:0,Number(sort_order)||0,published?1:0]
    );
    log('INFO','Game created',{id,title});
    res.json({ok:true,id});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: update game
app.put('/api/admin/games/:id',adminRequired,async(req,res)=>{
  const fields=['title','slug','description','genre','cover_url','banner_url','launch_url','asset_size','price','is_free','sort_order','published'];
  const updates=[];const vals=[];
  fields.forEach(f=>{if(req.body[f]!==undefined){updates.push(`${f}=?`);vals.push(req.body[f]);}});
  if(!updates.length)return res.status(400).json({error:'Nothing to update'});
  vals.push(req.params.id);
  try{
    const db=await getPool();
    await db.execute(`UPDATE games SET ${updates.join(',')} WHERE id=?`,vals);
    log('INFO','Game updated',{id:req.params.id});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: delete game
app.delete('/api/admin/games/:id',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    await db.execute('DELETE FROM games WHERE id=?',[req.params.id]);
    log('INFO','Game deleted',{id:req.params.id});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── newsletters ─────────────────────────────────────────────────────────
// Public/user: list published newsletters
app.get('/api/newsletters',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const lim=parseInt(req.query.limit,10)||20;
    const off=parseInt(req.query.offset,10)||0;
    const[rows]=await db.execute(`SELECT id,subject,author_name,published_at,created_at FROM newsletters WHERE published=1 ORDER BY published_at DESC LIMIT ${lim} OFFSET ${off}`);
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

// Public/user: single newsletter full content
app.get('/api/newsletters/:id',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM newsletters WHERE id=? AND published=1',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin/writer: list all newsletters
app.get('/api/admin/newsletters',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT id,subject,author_name,published,published_at,created_at FROM newsletters ORDER BY created_at DESC');
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin/writer: get full newsletter (for editing)
app.get('/api/admin/newsletters/:id',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM newsletters WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin/writer: create newsletter (draft)
app.post('/api/admin/newsletters',adminRequired,async(req,res)=>{
  const{subject,body_html}=req.body;
  if(!subject)return res.status(400).json({error:'subject required'});
  try{
    const db=await getPool();
    const id=crypto.randomUUID();
    await db.execute(
      'INSERT INTO newsletters(id,subject,body_html,author_id,author_name,published)VALUES(?,?,?,?,?,0)',
      [id,subject,body_html||'',req.user.userId,req.user.username]
    );
    log('INFO','Newsletter created',{id,subject});
    res.json({ok:true,id});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin/writer: update newsletter
app.put('/api/admin/newsletters/:id',adminRequired,async(req,res)=>{
  const{subject,body_html}=req.body;
  try{
    const db=await getPool();
    const[rows]=await db.execute('SELECT * FROM newsletters WHERE id=?',[req.params.id]);
    if(!rows.length)return res.status(404).json({error:'Not found'});
    // writers can only edit their own; admins can edit any
    if(req.user.role==='writer'&&rows[0].author_id!==req.user.userId)
      return res.status(403).json({error:'Not your newsletter'});
    const updates=[];const vals=[];
    if(subject!==undefined){updates.push('subject=?');vals.push(subject);}
    if(body_html!==undefined){updates.push('body_html=?');vals.push(body_html);}
    if(!updates.length)return res.status(400).json({error:'Nothing to update'});
    vals.push(req.params.id);
    await db.execute(`UPDATE newsletters SET ${updates.join(',')} WHERE id=?`,vals);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: publish newsletter
app.post('/api/admin/newsletters/:id/publish',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    await db.execute('UPDATE newsletters SET published=1,published_at=NOW() WHERE id=?',[req.params.id]);
    log('INFO','Newsletter published',{id:req.params.id});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: unpublish newsletter
app.post('/api/admin/newsletters/:id/unpublish',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    await db.execute('UPDATE newsletters SET published=0,published_at=NULL WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Admin: delete newsletter
app.delete('/api/admin/newsletters/:id',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    await db.execute('DELETE FROM newsletters WHERE id=?',[req.params.id]);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── user profiles ────────────────────────────────────────────────────────
// Public: get user profile
app.get('/api/users/:id/profile',validateTag,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(
      'SELECT id,username,bio,avatar_url,role,created_at FROM users WHERE id=? AND project_id=?',
      [req.params.id,req.projectId]
    );
    if(!rows.length)return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});

// Auth: update own profile
app.put('/api/users/me/profile',validateTag,authRequired,async(req,res)=>{
  const{bio,avatar_url}=req.body;
  const updates=[];const vals=[];
  if(bio!==undefined){updates.push('bio=?');vals.push(bio.slice(0,280));}
  if(avatar_url!==undefined){updates.push('avatar_url=?');vals.push(avatar_url);}
  if(!updates.length)return res.status(400).json({error:'Nothing to update'});
  vals.push(req.user.userId);
  try{
    const db=await getPool();
    await db.execute(`UPDATE users SET ${updates.join(',')} WHERE id=?`,vals);
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Auth: get own full profile
app.get('/api/users/me',validateTag,authRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(
      'SELECT id,username,email,bio,avatar_url,role,created_at,last_login FROM users WHERE id=?',
      [req.user.userId]
    );
    if(!rows.length)return res.status(404).json({error:'Not found'});
    res.json(rows[0]);
  }catch(err){res.status(500).json({error:err.message});}
});

// ── admin: user management ────────────────────────────────────────────────
// List all users
app.get('/api/admin/users',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[rows]=await db.execute(
      "SELECT id,username,email,role,bio,avatar_url,created_at,last_login FROM users WHERE project_id='__astro__' ORDER BY created_at DESC"
    );
    res.json(rows);
  }catch(err){res.status(500).json({error:err.message});}
});

// Update user role
app.put('/api/admin/users/:id/role',adminRequired,async(req,res)=>{
  const{role}=req.body;
  if(!['user','writer','moderator','admin'].includes(role))
    return res.status(400).json({error:'Invalid role'});
  try{
    const db=await getPool();
    await db.execute('UPDATE users SET role=? WHERE id=?',[role,req.params.id]);
    log('INFO','User role updated',{id:req.params.id,role});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Reset user password (admin sets temp password)
app.post('/api/admin/users/:id/reset-password',adminRequired,async(req,res)=>{
  const{password}=req.body;
  if(!password||password.length<8)return res.status(400).json({error:'Password must be at least 8 characters'});
  try{
    const db=await getPool();
    const hash=await bcrypt.hash(password,12);
    await db.execute('UPDATE users SET password_hash=? WHERE id=?',[hash,req.params.id]);
    log('INFO','Password reset',{id:req.params.id});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// Delete user
app.delete('/api/admin/users/:id',adminRequired,async(req,res)=>{
  if(req.params.id===req.user.userId)return res.status(400).json({error:'Cannot delete yourself'});
  try{
    const db=await getPool();
    await db.execute("DELETE FROM users WHERE id=? AND project_id='__astro__'",[req.params.id]);
    log('INFO','User deleted',{id:req.params.id});
    res.json({ok:true});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── admin: stats additions ────────────────────────────────────────────────
// (existing /api/stats gets games + newsletter counts appended below via patch)

// ── status
app.get('/api/status',(req,res)=>{
  loadConfig();
  res.json({status:'running',version:CFG.version,uptime:process.uptime(),network:CFG.network,ports:CFG.ports,ts:Date.now(),activeCalls:activeCalls.size});
});

app.get('/api/stats',adminRequired,async(req,res)=>{
  try{
    const db=await getPool();
    const[[{projects}]]=await db.execute("SELECT COUNT(*) as projects FROM projects WHERE id!='__astro__'");
    const[[{approved}]]=await db.execute("SELECT COUNT(*) as approved FROM projects WHERE status='approved' AND id!='__astro__'");
    const[[{activePeers}]]=await db.execute('SELECT COUNT(*) as activePeers FROM peers WHERE last_seen>DATE_SUB(NOW(),INTERVAL 5 MINUTE)');
    const[[{totalDocs}]]=await db.execute('SELECT COUNT(*) as totalDocs FROM data_store');
    const[[{totalMessages}]]=await db.execute('SELECT COUNT(*) as totalMessages FROM messages');
    const[[{pendingFlags}]]=await db.execute('SELECT COUNT(*) as pendingFlags FROM flagged_content WHERE reviewed=0');
    const[[{totalGames}]]=await db.execute('SELECT COUNT(*) as totalGames FROM games');
    const[[{publishedGames}]]=await db.execute('SELECT COUNT(*) as publishedGames FROM games WHERE published=1');
    const[[{totalNewsletters}]]=await db.execute('SELECT COUNT(*) as totalNewsletters FROM newsletters WHERE published=1');
    const[[{totalUsers}]]=await db.execute("SELECT COUNT(*) as totalUsers FROM users WHERE project_id='__astro__' AND role!='admin'");
    res.json({projects,approved,activePeers,totalDocs,totalMessages,pendingFlags,activeCalls:activeCalls.size,uptime:process.uptime(),totalGames,publishedGames,totalNewsletters,totalUsers});
  }catch(err){res.status(500).json({error:err.message});}
});

app.get('/api/network/ip',adminRequired,async(req,res)=>{
  try{
    const{default:fetch}=await import('node-fetch');
    const r=await fetch('https://api.ipify.org');const ip=await r.text();
    loadConfig();const old=CFG.network.publicIP;CFG.network.publicIP=ip;CFG.network.lastSeen=new Date().toISOString();
    fs.writeFileSync(CFG_PATH,JSON.stringify(CFG,null,2));
    res.json({ip,changed:ip!==old,old});
  }catch(err){res.status(500).json({error:err.message});}
});

// ── websocket
const server=http.createServer(app);
const wss=new WebSocketServer({server,path:'/ws'});
const projectPeers=new Map();
const userSockets=new Map();
const spaceRooms=new Map();
const activeCalls=new Map();
const MAX_RELAY=10;

function broadcastToProject(pid,msg){
  const peers=projectPeers.get(pid);if(!peers)return;
  const s=JSON.stringify(msg);peers.forEach(ws=>{if(ws.readyState===1)ws.send(s);});
}
function broadcastToUsers(pid,uids,msg){
  const s=JSON.stringify(msg);
  uids.forEach(uid=>{const socks=userSockets.get(uid);if(socks)socks.forEach(ws=>{if(ws.readyState===1)ws.send(s);});});
}
function broadcastToSpace(pid,sid,msg){
  const members=spaceRooms.get(sid);if(!members)return;
  const s=JSON.stringify(msg);members.forEach(ws=>{if(ws.readyState===1)ws.send(s);});
}
function sendTo(ws,msg){if(ws.readyState===1)ws.send(JSON.stringify(msg));}

wss.on('connection',(ws,req)=>{
  ws.projectId=null;ws.peerId=null;ws.userId=null;ws.username=null;ws.spaces=new Set();

  ws.on('message',async(raw)=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}

    if(msg.type==='join'){
      const decoded=decryptTag(msg.tag);
      if(!decoded){sendTo(ws,{type:'error',error:'Invalid tag'});return;}
      try{
        const db=await getPool();const hash=tagHash(decoded.projectId);
        const[rows]=await db.execute('SELECT id FROM projects WHERE id=? AND tag_hash=? AND status=?',[decoded.projectId,hash,'approved']);
        if(!rows.length){sendTo(ws,{type:'error',error:'Tag not approved'});return;}
        ws.projectId=decoded.projectId;ws.peerId=msg.peerId||crypto.randomUUID();
        if(!projectPeers.has(ws.projectId))projectPeers.set(ws.projectId,new Set());
        projectPeers.get(ws.projectId).add(ws);
        await db.execute('INSERT INTO peers(id,project_id,ip)VALUES(?,?,?) ON DUPLICATE KEY UPDATE last_seen=NOW(),project_id=VALUES(project_id)',[ws.peerId,ws.projectId,req.socket.remoteAddress]);
        if(msg.token){
          const tok=verifyToken(msg.token);
          if(tok){
            ws.userId=tok.userId;ws.username=tok.username;
            if(!userSockets.has(ws.userId))userSockets.set(ws.userId,new Set());
            userSockets.get(ws.userId).add(ws);
            await db.execute(`INSERT INTO user_presence(user_id,project_id,peer_id,last_seen,status)VALUES(?,?,?,NOW(),'online') ON DUPLICATE KEY UPDATE last_seen=NOW(),status='online',peer_id=VALUES(peer_id)`,[ws.userId,ws.projectId,ws.peerId]);
          }
        }
        sendTo(ws,{type:'joined',peerId:ws.peerId,projectId:ws.projectId});
        log('INFO','Peer joined',{peerId:ws.peerId,userId:ws.userId});
      }catch(err){sendTo(ws,{type:'error',error:'Server error'});}
    }

    if(msg.type==='space:join'&&ws.projectId){
      if(!spaceRooms.has(msg.spaceId))spaceRooms.set(msg.spaceId,new Set());
      spaceRooms.get(msg.spaceId).add(ws);ws.spaces.add(msg.spaceId);
    }
    if(msg.type==='space:leave'&&msg.spaceId){
      const m=spaceRooms.get(msg.spaceId);if(m)m.delete(ws);ws.spaces.delete(msg.spaceId);
    }

    if(msg.type==='broadcast'&&ws.projectId){
      broadcastToProject(ws.projectId,{type:'peer:message',from:ws.peerId,data:msg.data});
      try{const db=await getPool();await db.execute('INSERT INTO events(project_id,event_type,payload,peer_id)VALUES(?,?,?,?)',[ws.projectId,'broadcast',JSON.stringify(msg.data),ws.peerId]);}catch{}
    }

    // call signaling
    if(msg.type==='call:offer'&&ws.userId){
      const{to,offer,callId,callType='video',isRelay}=msg;
      if(isRelay){const rc=[...activeCalls.values()].filter(c=>c.relay).length;if(rc>=MAX_RELAY){sendTo(ws,{type:'call:busy',callId,reason:'Network at capacity. Try again soon.'});return;}}
      activeCalls.set(callId,{participants:[ws.userId,to],relay:!!isRelay,type:callType,startedAt:Date.now()});
      const ts=userSockets.get(to);
      if(ts?.size){ts.forEach(s=>sendTo(s,{type:'call:offer',from:ws.userId,fromName:ws.username,callId,offer,callType}));}
      else{sendTo(ws,{type:'call:no-answer',callId});activeCalls.delete(callId);}
    }
    if(msg.type==='call:answer'&&ws.userId){const ts=userSockets.get(msg.to);if(ts)ts.forEach(s=>sendTo(s,{type:'call:answer',from:ws.userId,callId:msg.callId,answer:msg.answer}));}
    if(msg.type==='call:ice'&&ws.userId){const ts=userSockets.get(msg.to);if(ts)ts.forEach(s=>sendTo(s,{type:'call:ice',from:ws.userId,callId:msg.callId,candidate:msg.candidate}));}
    if(msg.type==='call:end'){activeCalls.delete(msg.callId);if(msg.to){const ts=userSockets.get(msg.to);if(ts)ts.forEach(s=>sendTo(s,{type:'call:end',callId:msg.callId,from:ws.userId}));}}
    if(msg.type==='call:reject'&&ws.userId){activeCalls.delete(msg.callId);const ts=userSockets.get(msg.to);if(ts)ts.forEach(s=>sendTo(s,{type:'call:rejected',callId:msg.callId}));}

    if(msg.type==='typing'&&ws.userId){
      try{const db=await getPool();const[conv]=await db.execute('SELECT members FROM conversations WHERE id=?',[msg.conversationId]);if(conv.length){const m=typeof conv[0].members==='string'?JSON.parse(conv[0].members):conv[0].members;broadcastToUsers(ws.projectId,m.filter(id=>id!==ws.userId),{type:'typing',userId:ws.userId,username:ws.username,conversationId:msg.conversationId});}}catch{}
    }

    if(msg.type==='ping'){
      sendTo(ws,{type:'pong',ts:Date.now()});
      try{const db=await getPool();if(ws.peerId)await db.execute('UPDATE peers SET last_seen=NOW() WHERE id=?',[ws.peerId]);if(ws.userId)await db.execute('UPDATE user_presence SET last_seen=NOW() WHERE user_id=?',[ws.userId]);}catch{}
    }
  });

  ws.on('close',async()=>{
    if(ws.projectId){const p=projectPeers.get(ws.projectId);if(p)p.delete(ws);}
    if(ws.userId){
      const s=userSockets.get(ws.userId);if(s){s.delete(ws);if(!s.size){userSockets.delete(ws.userId);try{const db=await getPool();await db.execute("UPDATE user_presence SET status='offline' WHERE user_id=?",[ws.userId]);}catch{};}}
    }
    ws.spaces.forEach(sid=>{const m=spaceRooms.get(sid);if(m)m.delete(ws);});
    for(const[cid,call]of activeCalls){
      if(ws.userId&&call.participants.includes(ws.userId)){
        const other=call.participants.find(id=>id!==ws.userId);
        if(other){const ts=userSockets.get(other);if(ts)ts.forEach(s=>sendTo(s,{type:'call:end',callId:cid}));}
        activeCalls.delete(cid);
      }
    }
  });
});

// ── peerjs
const peerServer=PeerServer({port:CFG.ports.peerjs,path:'/peerjs',allow_discovery:false,corsOptions:{origin:'*'}});
peerServer.on('connection',(client)=>log('INFO','PeerJS connected',{id:client.getId()}));

// ── module generator
function xorObfuscate(str, key) {
  let out = '';
  for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return btoa(out);
}

function generateModule(encryptedTag, publicIP, ports) {
  // Obfuscate the endpoint — XOR with a random 16-byte key so IP/host never appear in plaintext
  const xorKey = require('crypto').randomBytes(16).toString('hex');
  const rawOrigin = `${publicIP}:${ports.http}`;
  const rawPeerHost = publicIP;
  const rawPeerPort = ports.peerjs;

  const obfOrigin   = xorObfuscate(rawOrigin, xorKey);
  const obfPeerHost = xorObfuscate(rawPeerHost, xorKey);
  const obfPeerPort = xorObfuscate(String(rawPeerPort), xorKey);

  return `/* Astro Client SDK */
(function(g){'use strict';
const _t='${encryptedTag}',_k='${xorKey}',_o='${obfOrigin}',_ph='${obfPeerHost}',_pp='${obfPeerPort}';
function _d(s,k){let o='';const b=atob(s);for(let i=0;i<b.length;i++)o+=String.fromCharCode(b.charCodeAt(i)^k.charCodeAt(i%k.length));return o;}
const _H='http://'+_d(_o,_k),_W='ws://'+_d(_o,_k),_PH=_d(_ph,_k),_PP=parseInt(_d(_pp,_k));
let ws=null,peerId=null,authToken=null,rt=null,wsOk=false,pollIv=null;const L={};
function emit(e,d){(L[e]||[]).forEach(fn=>fn(d));}
function startPoll(){if(pollIv)return;pollIv=setInterval(async()=>{try{if(authToken){const r=await api('GET','/conversations',null,true);emit('poll:conversations',r);}const p=await api('GET','/presence');emit('poll:presence',p);}catch{}},5000);}
function stopPoll(){if(pollIv){clearInterval(pollIv);pollIv=null;}}
function cWS(tok){try{ws=new WebSocket(_W+'/ws');ws.onopen=()=>{wsOk=true;stopPoll();ws.send(JSON.stringify({type:'join',tag:_t,peerId,token:tok||authToken}));setInterval(()=>{if(ws.readyState===1)ws.send(JSON.stringify({type:'ping'}));},15000);};ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==='joined'){peerId=m.peerId;emit('connected',m);}emit(m.type,m);emit('*',m);};ws.onclose=()=>{wsOk=false;emit('disconnected',{});startPoll();rt=setTimeout(()=>cWS(authToken),5000);};ws.onerror=()=>{wsOk=false;ws.close();startPoll();};}catch(e){wsOk=false;startPoll();}}
async function api(method,path,body,auth){const h={'Content-Type':'application/json','x-astro-tag':_t};if(auth&&authToken)h['Authorization']='Bearer '+authToken;const r=await fetch(_H+'/api'+path,{method,headers:h,body:body?JSON.stringify(body):undefined});if(!r.ok)throw await r.json().catch(()=>({error:r.statusText}));return r.json();}
function saveToken(t){authToken=t;try{sessionStorage.setItem('astro_token',t);}catch{}}
function loadToken(){try{return sessionStorage.getItem('astro_token');}catch{return null;}}
function clearToken(){authToken=null;try{sessionStorage.removeItem('astro_token');}catch{}}
const Astro={
connect(t){if(t)saveToken(t);else{const st=loadToken();if(st)authToken=st;}cWS(authToken);return this;},
on(e,fn){L[e]=L[e]||[];L[e].push(fn);return this;},
off(e,fn){L[e]=(L[e]||[]).filter(f=>f!==fn);return this;},
send(m){if(ws&&ws.readyState===1)ws.send(JSON.stringify(m));},
broadcast(d){Astro.send({type:'broadcast',data:d});},
isConnected(){return wsOk;},
async register(u,p,e){const r=await api('POST','/users/register',{username:u,password:p,email:e});saveToken(r.token);return r;},
async login(u,p){const r=await api('POST','/users/login',{username:u,password:p});saveToken(r.token);return r;},
logout(){clearToken();},
restoreSession(){const t=loadToken();if(t){authToken=t;}return !!t;},
getToken(){return authToken;},
isConnected(){return wsOk;},
async list(c,o={}){const p=new URLSearchParams(o).toString();return api('GET','/data/'+c+(p?'?'+p:''));},
async get(c,id){return api('GET','/data/'+c+'/'+id);},
async set(c,id,d){return api('PUT','/data/'+c+'/'+id,d,true);},
async del(c,id){return api('DELETE','/data/'+c+'/'+id,null,true);},
async getConversations(){return api('GET','/conversations',null,true);},
async createConversation(type,name,memberIds){return api('POST','/conversations',{type,name,memberIds},true);},
async getMessages(id,o={}){const p=new URLSearchParams(o).toString();return api('GET','/conversations/'+id+'/messages'+(p?'?'+p:''),null,true);},
async sendMessage(id,content,type='text'){return api('POST','/conversations/'+id+'/messages',{content,type},true);},
async reactMessage(id,emoji){return api('POST','/messages/'+id+'/react',{emoji},true);},
async getSpaces(){return api('GET','/spaces');},
async getMySpaces(){return api('GET','/spaces/mine',null,true);},
async createSpace(d){return api('POST','/spaces',d,true);},
async joinSpace(id,code){return api('POST','/spaces/'+id+'/join',{inviteCode:code},true);},
async leaveSpace(id){return api('DELETE','/spaces/'+id+'/leave',null,true);},
async getSpacePosts(id,type='board'){return api('GET','/spaces/'+id+'/posts?type='+type);},
async postToSpace(id,content,type='stream',image){return api('POST','/spaces/'+id+'/posts',{content,type,image},true);},
async flamePost(id){return api('POST','/spaces/posts/'+id+'/flame',{},true);},
async searchUsers(q){return api('GET','/users/search?q='+encodeURIComponent(q),null,true);},
async getPresence(){return api('GET','/presence');},
async getGames(){const r=await fetch(_H+'/api/games');if(!r.ok)throw{};return r.json();},
async getGame(id){const r=await fetch(_H+'/api/games/'+id);if(!r.ok)throw{};return r.json();},
async getNewsletters(){return api('GET','/newsletters',null,true);},
async getNewsletter(id){return api('GET','/newsletters/'+id,null,true);},
async getMe(){return api('GET','/users/me',null,true);},
async getProfile(id){return api('GET','/users/'+id,null,true);},
async updateProfile(d){return api('PUT','/users/me',d,true);},
cdnUrl(path){return _H+'/cdn/'+path;},
createPeer(id){if(!g.Peer)throw new Error('PeerJS not loaded');return new g.Peer(id||undefined,{host:_PH,port:_PP,path:'/peerjs',secure:false});}
};g.Astro=Astro;})(window);`;
}

server.listen(CFG.ports.http,()=>{
  log('INFO',`Astro Core running on port ${CFG.ports.http}`);
  log('INFO',`PeerJS running on port ${CFG.ports.peerjs}`);
});
process.on('uncaughtException',(err)=>log('ERROR','Uncaught exception',{err:err.message}));
process.on('unhandledRejection',(err)=>log('ERROR','Unhandled rejection',{err:err?.message}));