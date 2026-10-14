export function sameDatasetFile(a,b,{pathToHandle=false,platform=process.platform}={}){
  const sameDevice=a.dev===b.dev||(pathToHandle&&platform==='win32'&&(a.dev===0n||BigInt.asUintN(32,a.dev)===BigInt.asUintN(32,b.dev)));
  return sameDevice&&a.ino===b.ino;
}
export function dataPath(path){if(!path||Buffer.byteLength(path)>4096||path.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>['','.','..'].includes(part)))throw Error('请使用目录内的相对路径：'+path);return path;}
