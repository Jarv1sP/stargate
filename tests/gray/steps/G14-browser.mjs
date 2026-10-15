import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project,call} from '../lib/exec.mjs';
import {adminSession} from '../lib/accounts.mjs';
import {sections} from '../lib/sections.mjs';
export default {id:'G14',title:'真实网页、公告及三种宽度（FEATURES 界面）',level:'full',async run(ctx){
  const {name,member}=await project(ctx),admin=await adminSession(ctx),screens=join(ctx.artifacts,'screens');await mkdir(screens,{recursive:true});
  await call(ctx,admin,'community.posts.create',{key:ctx.key(),kind:'announcement',title:'灰度网页定向弹窗',body:'仅成员A收到',popup:true,audience:{type:'users',userIds:[member.userId]}});
  const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}}),external=[],errors=[],checks=[];
  try{
    for(const [role,account] of [['admin',ctx.admin],['member',member]]){
      const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(15000);
      await page.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==ctx.stack.origin){external.push(url.origin);return route.abort();}return route.continue();});
      page.on('pageerror',error=>errors.push({role,error:error.message}));
      try{
        await page.goto(ctx.stack.origin);await page.locator('#login-form [name=username]').fill(account.username);await page.locator('#login-form [name=password]').fill(account.password);await page.locator('#login-form [type=submit]').click();await page.locator('#login-dialog').waitFor({state:'hidden'});
        if(role==='member'){
          await page.locator('#announcement-dialog').waitFor({state:'visible'});await page.locator('#announcement-title').filter({hasText:'灰度网页定向弹窗'}).waitFor();
          checks.push(['A 实际看到定向弹窗',async()=>ctx.check('A 实际看到定向弹窗',true)]);
          await page.screenshot({path:join(screens,'member-announcement.png'),fullPage:true});await page.locator('#announcement-ack').click();await page.locator('#announcement-dialog').waitFor({state:'hidden'});
        }
        for(const width of [1440,390,320]){
          await page.setViewportSize({width,height:1000});
          for(const [label,route,button] of [['resources','resources','[data-nav=resources]'],['projects','work','#projects-refresh'],['jobs','work','#my-job-table'],['datasets','datasets','#dataset-upload-form'],['community','community','[data-nav=community]']]){
            const title=role+'/'+width+'/'+label;
            try{
              await page.evaluate(hash=>{location.hash='#'+hash;},route);await page.locator('#page-'+route).waitFor({state:'visible'});
              await page.locator(button).evaluate(element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;});
              await page.locator(button).scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
              const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),visible=await page.locator(button).isVisible();
              await page.screenshot({path:join(screens,role+'-'+width+'-'+label+'.png'),fullPage:true,animations:'disabled'});
              checks.push([title,async()=>{ctx.check(title+' 无横向滚动',!overflow);ctx.check(title+' 主要入口可见',visible);}]);
            }catch(error){checks.push([title,async()=>{throw error;}]);}
          }
          await page.goto(ctx.stack.origin+'/guide');await page.screenshot({path:join(screens,role+'-'+width+'-guide.png'),fullPage:true});
          const guide=await page.locator('body').innerText(),chapters=await page.locator('.guide-card').count(),guideOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);checks.push([role+'/'+width+'/guide',async()=>{ctx.check('使用指南与七章入口可读',guide.includes('STARGATE')&&guide.includes('使用指南')&&chapters===7);ctx.check('指南无横向滚动',!guideOverflow);}]);
          await page.goto(ctx.stack.origin+'/#work');await page.locator('#login-dialog').waitFor({state:'hidden'});
        }
        await page.evaluate(()=>{location.hash='#work';});
        await page.waitForFunction(name=>[...document.querySelectorAll('[name=workspace-project] option')].some(o=>o.dataset.project===name),name);
        const value=await page.locator('[name=workspace-project] option').evaluateAll((options,name)=>options.find(o=>o.dataset.project===name).value,name);
        await page.locator('[name=workspace-project]').selectOption(value);
        await page.locator('#terminal-open').evaluate(element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;});
        await page.locator('#terminal-open').click();await page.locator('#terminal-disconnect').waitFor({state:'visible'});
        for(const width of [1440,390,320]){
          await page.setViewportSize({width,height:1000});const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),visible=await page.locator('#terminal-disconnect').isVisible();
          await page.screenshot({path:join(screens,role+'-'+width+'-terminal.png'),fullPage:true,animations:'disabled'});
          checks.push([role+'/'+width+'/terminal',async()=>{ctx.check('终端无横向滚动 '+role+width,!overflow);ctx.check('终端主要按钮可见 '+role+width,visible);}]);
        }
        await page.locator('.xterm-helper-textarea').pressSequentially('exit');await page.locator('.xterm-helper-textarea').press('Enter');
      }catch(error){checks.push([role+' 网页流程',async()=>{throw error;}]);}
      finally{await context.close();}
    }
  }finally{await browser.close();await writeFile(join(ctx.artifacts,'browser-observations.json'),JSON.stringify({external,errors},null,2)+'\n');}
  checks.push(['浏览器运行错误与外部请求',async()=>{ctx.check('无浏览器脚本异常',errors.length===0,errors);ctx.check('无外部请求',external.length===0,external);}]);
  await sections(ctx,checks);
}};
