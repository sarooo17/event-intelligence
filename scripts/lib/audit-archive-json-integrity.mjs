/**
 * Fatal UTF-8 + unambiguous JSON member names for signed audit archive bytes.
 * JSON.parse alone accepts duplicate keys (last wins) and Buffer.toString()
 * substitutes U+FFFD for malformed input, both unsafe for a signed archive
 * that other compliant parsers or external systems may interpret differently.
 *
 * Parses once via built-in JSON.parse after a bounded lexical pass. Member
 * names are compared AFTER JSON unescaping, e.g. "scope" vs "sc\\u006fpe".
 */
export function parseUnambiguousAuditArchiveJson(rawBytes) {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length < 2 ||
      rawBytes.length > 64 * 1024 * 1024) {
    throw new TypeError('Audit JSON bytes must be a bounded nonempty Buffer');
  }
  const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
    .decode(rawBytes);
  let i=0;
  const fail=()=>{throw new SyntaxError('Ambiguous or invalid signed audit JSON');};
  const spaces=()=>{while(i<source.length &&
    (source[i]===' '||source[i]==='\n'||source[i]==='\r'||source[i]==='\t'))i++;};
  const stringToken=()=>{
    if(source[i]!=='"')fail();
    const start=i++;
    let escaped=false;
    while(i<source.length){
      const ch=source[i++];
      if(escaped){escaped=false;continue;}
      if(ch==='\\'){escaped=true;continue;}
      if(ch==='"')return JSON.parse(source.slice(start,i));
      if(ch<' ' )fail();
    }
    fail();
  };
  const value=(depth)=>{
    if(depth>64)fail();
    spaces();
    const ch=source[i];
    if(ch==='{'){
      i++;spaces();
      const seen=new Set();
      if(source[i]==='}'){i++;return;}
      while(i<source.length){
        spaces();
        const key=stringToken();
        if(seen.has(key))fail();
        seen.add(key);
        spaces();if(source[i++]!==':')fail();
        value(depth+1);spaces();
        if(source[i]==='}'){i++;return;}
        if(source[i++]!==',')fail();
      }
      fail();
    }
    if(ch==='['){
      i++;spaces();
      if(source[i]===']'){i++;return;}
      while(i<source.length){
        value(depth+1);spaces();
        if(source[i]===']'){i++;return;}
        if(source[i++]!==',')fail();
      }
      fail();
    }
    if(ch==='"'){stringToken();return;}
    if(ch==='-'||(ch>='0'&&ch<='9')){
      const start=i;
      if(source[i]==='-')i++;
      if(source[i]==='0')i++;
      else{
        if(source[i]<'1'||source[i]>'9')fail();
        while(source[i]>='0'&&source[i]<='9')i++;
      }
      if(source[i]==='.'){
        i++;if(source[i]<'0'||source[i]>'9')fail();
        while(source[i]>='0'&&source[i]<='9')i++;
      }
      if(source[i]==='e'||source[i]==='E'){
        i++;if(source[i]==='+'||source[i]==='-')i++;
        if(source[i]<'0'||source[i]>'9')fail();
        while(source[i]>='0'&&source[i]<='9')i++;
      }
      if(i===start)fail();
      return;
    }
    const known=ch==='t'?'true':ch==='f'?'false':ch==='n'?'null':null;
    if(!known||source.slice(i,i+known.length)!==known)fail();
    i+=known.length;
  };
  value(0);spaces();
  if(i!==source.length)fail();
  return {text:source,parsed:JSON.parse(source)};
}
