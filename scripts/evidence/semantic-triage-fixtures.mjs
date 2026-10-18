// Fixed, synthetic and entirely fictional triage corpus. Labels are authored
// independently of scripted scores. This is NOT a real-user quality claim.
export const SYNTHETIC_TRIAGE_CORPUS_VERSION = 'ei.semantic-triage-corpus.v1';

export const SYNTHETIC_TRIAGE_CASES = Object.freeze([
  { id:'01', category:'security', title:'Authorization bypass confirmed in login flow', important:true, probability:0.97, tokens:212, eligible:true },
  { id:'02', category:'release', title:'Breaking SDK field removed before release', important:true, probability:0.92, tokens:160, eligible:true },
  { id:'03', category:'operations', title:'Production rollout blocked by failing migration', important:true, probability:0.84, tokens:210, eligible:true },
  { id:'04', category:'quality', title:'Regression test fails on latest release commit', important:true, probability:0.77, tokens:138, eligible:true },
  { id:'05', category:'approval', title:'Maintainer requests required product decision', important:true, probability:0.68, tokens:119, eligible:true },
  { id:'06', category:'availability', title:'Rare data loss pattern found in webhook replay', important:true, probability:0.88, tokens:340, eligible:true },
  { id:'07', category:'cosmetic', title:'README heading capitalization changed', important:false, probability:0.10, tokens:85, eligible:true },
  { id:'08', category:'format', title:'Automated formatter updates whitespace', important:false, probability:0.06, tokens:125, eligible:true },
  { id:'09', category:'ci', title:'CI returns to green after transient runner retry', important:false, probability:0.41, tokens:140, eligible:true },
  { id:'10', category:'release', title:'Docs-only label bump on release issue', important:false, probability:0.32, tokens:115, eligible:true },
  { id:'11', category:'noise', title:'One additional bot subscription heartbeat', important:false, probability:0.99, tokens:120, eligible:false },
  { id:'12', category:'risk', title:'Seemingly small dependency bump introduces API break', important:true, probability:0.56, tokens:170, eligible:true },
  { id:'13', category:'planning', title:'Nonbinding planning discussion continued', important:false, probability:0.74, tokens:100, eligible:true },
  { id:'14', category:'noise', title:'Change comment reaction counts', important:false, probability:0.80, tokens:75, eligible:false },
]);
