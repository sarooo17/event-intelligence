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
/**
 * Normalize the EXACT decimal mathematical value, not an IEEE-754 binary
 * approximation. 300e-2, 3 and 3.000 have the same identity, but 3e-324
 * and 4e-324 must NOT collapse to the same Number.toString() output.
 * The numeric scanner checks lexemes before calling this helper.
 */
function decimalIdentity(token) {
  if(token.length>512)throw unsafe();
  const match=/^(-?)(0|[1-9][0-9]*)(?:\\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if(!match || (match[4] && match[4].length>8))throw unsafe();
  const digits=match[2]+(match[3]??'');
  let coefficient=digits.replace(/^0+/,'');
  if(!coefficient)return '0';
  let exponent=BigInt(match[4]??0)-BigInt((match[3]??'').length);
  const trailing=coefficient.match(/0+$/)?.[0].length??0;
  coefficient=coefficient.slice(0,coefficient.length-trailing);
  exponent+=BigInt(trailing);
  return (match[1]||'+')+':'+coefficient+':'+exponent;
}

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
    // Compare canonical DECIMAL identities, not just digit count.
    // JS Number.toString() is the exact spelling used downstream when
    // the audit record is canonicalized for hashing. Every altered
    // lexeme that rounds into the same JS Number now fails closed,
    // including nonzero subnormals and high-precision mantissas.
    if (!Number.isSafeInteger(parsed) && Number.isInteger(parsed)) {
      throw unsafe();
    }
    if(decimalIdentity(token)!==decimalIdentity(String(parsed)))throw unsafe();
  }
  if(quoted||escaped)throw unsafe();
}
function unsafe(){
  const error=new Error('Audit JSON number is not losslessly safe for JavaScript JSON hashing');
  error.code='EVENT_INTELLIGENCE_AUDIT_PRECISION_UNSAFE';
  return error;
}
