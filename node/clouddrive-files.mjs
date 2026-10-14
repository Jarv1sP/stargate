// Existing CD2 protobuf/transport, for authenticated file operations.
import http from 'node:http';
import https from 'node:https';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
const RPC_MS=15000;
const text=(v,max=255)=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=max&&!/[\x00-\x1f\x7f]/.test(v);
const fail=(message,status=400)=>{throw Object.assign(Error(message),{status});};
const safe=e=>Object.assign(Error(e?.code===16?'云文件服务登录失效，请联系管理员。':'云文件状态暂时未知，请按原编号查询或续传。'),{status:e?.code===16?403:502,grpcCode:e?.code});
function endpointURL(endpoint, allowInsecureLoopback) {
  let url; try { url = new URL(endpoint); } catch { fail('CD2 节点本地地址无效。'); }
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || url.protocol === 'http:' && !allowInsecureLoopback) fail('普通文件适配器仅允许明确批准的节点本地 CD2 回环地址。');
  return url;
}

// JSON form of the narrow official protobuf subset. No account enumeration,
// delete, share, mount, credentials-exchange or arbitrary command RPC exists.
const field = (type, id, extra = {}) => ({type, id, ...extra});
const message = fields => ({fields});
const types = {
  FindFileByPathRequest: message({parentPath: field('string', 1), path: field('string', 2)}),
  CreateFileRequest: message({parentPath: field('string', 1), fileName: field('string', 2)}),
  CreateFileResult: message({fileHandle: field('uint64', 1)}),
  WriteFileRequest: message({fileHandle: field('uint64', 1), startPos: field('uint64', 2), length: field('uint64', 3), buffer: field('bytes', 4), closeFile: field('bool', 5), uploadImmediately: field('bool', 6)}),
  WriteFileResult: message({bytesWritten: field('uint64', 1)}),
  CloseFileRequest: message({fileHandle: field('uint64', 1), uploadImmediately: field('bool', 2)}),
  FileOperationResult: message({success: field('bool', 1), errorMessage: field('string', 2), resultFilePaths: field('string', 3, {rule: 'repeated'})}),
  ListSubFileRequest: message({path: field('string', 1), forceRefresh: field('bool', 2), checkExpires: field('bool', 3)}),
  SubFilesReply: message({subFiles: field('CloudDriveFile', 1, {rule: 'repeated'})}),
  GetDownloadUrlPathRequest: message({path: field('string', 1), preview: field('bool', 2), lazy_read: field('bool', 3), get_direct_url: field('bool', 4)}),
  DownloadUrlPathInfo: message({downloadUrlPath: field('string', 1), expiresIn: field('uint64', 2), directUrl: field('string', 3)}),
  CloudAPI: message({name: field('string', 1), userName: field('string', 2), isLocked: field('bool', 4), path: field('string', 10), readOnly: field('bool', 12)}),
  CloudDriveFile: message({id: field('string', 1), name: field('string', 2), fullPathName: field('string', 3), size: field('int64', 4), fileType: field('int32', 5), CloudAPI: field('CloudAPI', 9), isDirectory: field('bool', 30), isRoot: field('bool', 31), isCloudRoot: field('bool', 32), isCloudDirectory: field('bool', 33), isCloudFile: field('bool', 34), isSearchResult: field('bool', 35), isForbidden: field('bool', 36), isLocal: field('bool', 37), readOnly: field('bool', 80)}),
};
const methodTypes = {
  FindFileByPath:['FindFileByPathRequest','CloudDriveFile'],CreateFile:['CreateFileRequest','CreateFileResult'],WriteToFile:['WriteFileRequest','WriteFileResult'],CloseFile:['CloseFileRequest','FileOperationResult'],
  GetSubFiles: ['ListSubFileRequest','SubFilesReply'],
  GetDownloadUrlPath: ['GetDownloadUrlPathRequest', 'DownloadUrlPathInfo'],
};
export function cloudDriveFilesDefinition() {
  const methods = Object.fromEntries(Object.entries(methodTypes).map(([name, [requestType, responseType]]) => [name, {requestType, responseType, ...(name === 'GetSubFiles' ? {responseStream: true} : {})}]));
  return protoLoader.fromJSON({nested: {clouddrive: {nested: {...types, CloudDriveFileSrv: {methods}}}}}, {keepCase: true, longs: String, defaults: true});
}

/** Constructing this transport makes no request; it must run on the CD2 node. */
export function createCloudDriveFilesTransport({endpoint, allowInsecureLoopback = false} = {}) {
  const url = endpointURL(endpoint, allowInsecureLoopback);
  const Service = grpc.loadPackageDefinition(cloudDriveFilesDefinition()).clouddrive.CloudDriveFileSrv;
  const client = new Service(url.host, url.protocol === 'https:' ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
    'grpc.enable_http_proxy': 0, 'grpc.enable_retries': 0,
    'grpc.max_send_message_length': 1024 * 1024, 'grpc.max_receive_message_length': 1024 * 1024,
  });
  return {
    endpoint: url.origin,
    close() { client.close(); },
    rpc(method, body, {token, signal} = {}) {
      if (!Object.hasOwn(methodTypes, method)) fail('CD2 RPC 不在普通文件白名单内。', 403);
      if (!text(token, 16384) || !/^[\x21-\x7e]+$/.test(token)) fail('CD2 节点授权未配置。', 409);
      if (signal?.aborted) fail('节点文件操作已请求取消。', 409);
      const metadata = new grpc.Metadata(); metadata.set('authorization', 'Bearer ' + token);
      return new Promise((resolve, reject) => {
        let call, done = false; const subFiles = [];
        const finish = (error, value) => {
          if (done) return; done = true; signal?.removeEventListener('abort', abort);
          if (error) reject(safe(error)); else resolve(value);
        };
        const abort = () => { finish(Object.assign(Error(), {code: 1})); call?.cancel(); };
        try {
          const options = {deadline: new Date(Date.now() + RPC_MS)};
          if (method === 'GetSubFiles') {
            call = client[method](body, metadata, options);
            call.on('data', value => {
              if (done) return;
              if (!Array.isArray(value?.subFiles)) { finish(Error()); call.cancel(); return; }
              subFiles.push(...value.subFiles);
            });
            call.on('error', error => finish(error)); call.on('end', () => finish(null, {subFiles}));
          } else call = client[method](body, metadata, options, finish);
          signal?.addEventListener('abort', abort, {once: true}); if (signal?.aborted) abort();
        } catch (error) { finish(error); }
      });
    },
    // Internal only. No redirects or environmental HTTP proxies. No API token
    // is sent as an HTTP header; CD2's own signed static descriptor stays local.
    read(staticPath, {offset, signal} = {}) {
      const target = localStaticURL(staticPath, url, '');
      return new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(target, {
          method: 'GET', signal, headers: offset ? {Range: `bytes=${offset}-`} : {},
        }, response => {
          response.on('error', () => {});
          resolve({status: response.statusCode, headers: response.headers, body: response, close: () => response.destroy()});
        });
        request.setTimeout(RPC_MS, () => request.destroy(Error('timeout')));
        request.on('error', error => reject(safe(error))); request.end();
      });
    },
  };
}

function localStaticURL(value, endpoint, token, filePath) {
  if (!text(value, 16384) || !value.startsWith('/static/') || value.startsWith('//') || /[\\\r\n]/.test(value)) fail('CD2 没有返回节点本地文件流。', 409);
  let decoded; try { decoded = decodeURIComponent(value); } catch { fail('CD2 文件流地址无效。', 502); }
  if (decoded.split(/[/?#]/).some(p => p === '.' || p === '..') || /%(?:2e|2f|5c)/i.test(decoded)) fail('CD2 文件流描述符未获允许。', 403);
  const expanded = value.replaceAll('{SCHEME}', endpoint.protocol.slice(0, -1)).replaceAll('{HOST}', endpoint.host).replaceAll('{PREVIEW}', 'false');
  const url = new URL(expanded, endpoint);
  if (url.origin !== endpoint.origin || !url.pathname.startsWith('/static/') || url.username || url.password || url.hash) fail('CD2 文件流地址越界。', 403);
  if (token && (url.searchParams.has('token') || value.includes(token) || decoded.includes(token))) {
    // CD2 v1.1.1 puts its scoped API token in the local static stream's
    // query. Permit only the exact authenticated file descriptor on the
    // fixed loopback endpoint. It never leaves this node-local transport.
    const rest = new URL(url); rest.searchParams.delete('token');
    const expected = `/static/${endpoint.protocol.slice(0, -1)}/${endpoint.host}/false${filePath}`;
    if (!['127.0.0.1', '[::1]'].includes(endpoint.hostname) || typeof filePath !== 'string'
        || decodeURIComponent(url.pathname) !== expected
        || url.searchParams.getAll('token').length !== 1 || url.searchParams.get('token') !== token
        || rest.href.includes(token) || decodeURIComponent(rest.href).includes(token)) fail('CD2 文件流授权描述符未获允许。', 403);
  }
  return url;
}
