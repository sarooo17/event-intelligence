/**
 * Fail-closed precision policy for audit JSON proof material.
 *
 * PostgreSQL JSONB is arbitrary precision; JS JSON.parse is not. If a
 * received numeric lexeme cannot be represented without plausible
 * information loss, NEVER feed its parsed value into AuditChain hashing.
 * This rejects some legitimate large/high-precision numerics; operators
 * must store those fields as strings or introduce precision-aware hashes.
 *
 * Not a JSON parser: the caller also validates JSON syntax/shape.
 */
export function assertAuditJsonNumberPrecision(raw) {
  if (typeof raw !== 'string' || !raw.length) {
    throw new TypeError('Expected raw audit JSON text');
  }
  let quoted=false,escaped=false;
  for (let i=0;i<raw.length;) {
    const c=raw[i];
    if(quoted){
      if(escaped)escaped=false;
      else if(c==='\\')escaped=true;
      else if(c==='"')quoted=false;
      i++;continue;
    }
    if(c==='"'){quoted=true;i++;continue;}
    if(c!=='-' && (c<'0'||c>'9')){i++;continue;}
    const start=i;
    if(raw[i]==='-')i++;
    if(raw[i]==='0')i++;
    else {
      if(raw[i]<'1'||raw[i]>'9')throw unsafe();
      while(raw[i]>='0'&&raw[i]<='9')i++;
    }
    let dot=false;
    if(raw[i]==='.'){
      dot=true;i++;
      if(raw[i]<'0'||raw[i]>'9')throw unsafe();
      while(raw[i]>='0'&&raw[i]<='9')i++;
    }
    if(raw[i]==='e'||raw[i]==='E'){
      i++;
      if(raw[i]==='+'||raw[i]==='-')i++;
      if(raw[i]<'0'||raw[i]>'9')throw unsafe();
      while(raw[i]>='0'&&raw[i]<='9')i++;
    }
    const token=raw.slice(start,i);
    const parsed=Number(token);
    if(!Number.isFinite(parsed))throw unsafe();
    const mantissa=token.split(/[eE]/,1)[0];
    const digits=mantissa.replace(/[^0-9]/g,'');
    const significant=digits.replace(/^0+/,'').replace(/0+$/,'');
    // Unsafe integers and >=16 significant nonzero digits have
    // ambiguous JS-Number roundtrips. Also reject underflow to zero.
    if((Number.isInteger(parsed)&&!Number.isSafeInteger(parsed)) ||
       significant.length>15 && !Number.isSafeInteger(parsed) ||
       parsed===0 && /[1-9]/.test(digits))throw unsafe();
    if(dot && !Number.isSafeInteger(parsed) && significant.length>15)
      throw unsafe();
  }
  if(quoted||escaped)throw unsafe();
}
function unsafe(){
  const error=new Error('Audit JSON number is not losslessly safe for JavaScript JSON hashing');
  error.code='EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE';
  return error;
}
