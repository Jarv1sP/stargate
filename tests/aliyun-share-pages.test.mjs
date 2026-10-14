import test from 'node:test';
import assert from 'node:assert/strict';
import {AliyunShare,shareReference} from '../aliyun-share.mjs';

test('Aliyun share root listing follows every marker beyond 500 entries',async()=>{
  const entries=Array.from({length:637},(_,index)=>({type:'file',file_id:'fixture-'+index,
    name:'input-'+index+'.bin',size:index+1,drive_id:'fixture-drive'}));
  const pages=[],source=shareReference('https://www.alipan.com/s/fixture-share');let tokens=0;
  const client=new AliyunShare({load:()=>null,save:()=>assert.fail('listing does not save credentials'),
    request:async(url,options)=>{
      const request=JSON.parse(options.body);
      assert.equal(options.method,'POST');assert.equal(request.share_id,source.shareId);
      if(new URL(url).pathname==='/v2/share_link/get_share_token'){
        tokens++;return Response.json({share_token:'fixture-share-token'});
      }
      assert.equal(new URL(url).pathname,'/adrive/v3/file/list');
      assert.equal(request.parent_file_id,'root');assert.equal(request.limit,100);
      assert.equal(options.headers['x-share-token'],'fixture-share-token');
      const page=request.marker?Number(request.marker.slice(5)):0;
      pages.push(request.marker);
      return Response.json({items:entries.slice(page*100,(page+1)*100),
        next_marker:(page+1)*100<entries.length?'page-'+(page+1):''});
    }});
  const files=await client.list(source);
  assert.equal(tokens,1);
  assert.deepEqual(pages,['','page-1','page-2','page-3','page-4','page-5','page-6']);
  assert.deepEqual(files,entries.map(file=>({id:file.file_id,name:file.name,size:file.size,driveId:file.drive_id})));
});
