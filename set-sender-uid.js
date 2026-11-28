require('dotenv').config({quiet:true});
const fs=require('fs');
const {initializeApp,cert}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const name=process.argv[2];
const src=fs.readFileSync('public/script.js','utf8');
const rc=(n,f)=>{const m=src.match(new RegExp(n+"\\s*=\\s*['\"]([^'\"]+)['\"]"));return m?m[1]:f;};
const USERS=rc('USERS_COLLECTION','users'), LOOK=rc('USERNAME_LOOKUP_COLLECTION','usernames');
initializeApp({credential:cert(JSON.parse(fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH||'./serviceAccountKey.json','utf8'))),projectId:process.env.FIREBASE_PROJECT_ID});
const db=getFirestore();
(async()=>{
 let doc=null;
 const lk=await db.collection(LOOK).doc(name.toLowerCase()).get();
 if(lk.exists){const d=lk.data();const uid=d.uid||d.userId||Object.values(d).find(v=>typeof v==='string'&&v.length>=20);if(uid){const u=await db.collection(USERS).doc(uid).get();if(u.exists)doc=u;}}
 if(!doc){const q=await db.collection(USERS).where('username','==',name).limit(1).get();if(!q.empty)doc=q.docs[0];}
 if(!doc){console.error('User not found');process.exit(1);}
 const uid=doc.data().uid||doc.id;
 const t=fs.readFileSync('.env','utf8');const eol=t.includes('\r\n')?'\r\n':'\n';
 let done=false;
 const out=t.split(/\r?\n/).map(l=>l.startsWith('TEST_SENDER_ID=')?(done=true,'TEST_SENDER_ID='+uid):l);
 if(!done)out.push('TEST_SENDER_ID='+uid);
 fs.writeFileSync('.env',out.join(eol));
 console.log('OK. TEST_SENDER_ID set to uid: '+uid);process.exit(0);
})();
