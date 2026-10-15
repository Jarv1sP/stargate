import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {project,call} from '../lib/exec.mjs';
import {adminSession} from '../lib/accounts.mjs';
import {sections} from '../lib/sections.mjs';
export default {features:["网页和 CLI 打开项目终端，断开重连、接管", "公告：定向发送、弹窗、外观、CLI 未读提醒和已读确认", "使用指南、帮助、CLI 安装（Linux/Windows/macOS）与更新"],id:'G14',title:'真实网页、公告及三种宽度（FEATURES 界面）',level:'full',async run(ctx){
  const {name,member}=await project(ctx),admin=await adminSession(ctx),screens=join(ctx.artifacts,'screens');await mkdir(screens,{recursive:true});
  await call(ctx,admin,'community.posts.create',{key:ctx.key(),kind:'announcement',title:'灰度网页定向弹窗',body:'仅成员A收到',popup:true,audience:{type:'users',userIds:[member.userId]}});
  const browser=await chromium.launch({headless:true,...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}}),external=[],errors=[],checks=[];
  try{
    for(const [role,account] of [['admin',ctx.admin],['member',member]]){
      const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();page.setDefaultTimeout(15000);
      await page.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==ctx.stack.origin){external.push(url.origin);return route.abort();}return route.continue();});
      page.on('pageerror',error=>errors.push({role,error:error.message}));
      try{
        const login=await context.request.post(ctx.stack.origin+'/api/login',{headers:{Origin:ctx.stack.origin},data:{username:account.username,password:account.password,client:'browser'}});ctx.check(role+' 测试会话登录成功',login.ok(),{status:login.status()});
        const cookieName=login.headers()['set-cookie']?.split('=',1)[0];
        ctx.check(role+' 浏览器收到会话 cookie',!!cookieName&&(await context.cookies()).some(cookie=>cookie.name===cookieName));
        await page.goto(ctx.stack.origin);await page.locator('[data-nav=resources][aria-current=page]').waitFor();
        ctx.check('不再显示本地登录注册表单',await page.locator('#login-dialog,#register-dialog').count()===0);
        if(role==='admin'){
          const motionContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
          try{
            await motionContext.addCookies(await context.cookies());const motionPage=await motionContext.newPage();motionPage.setDefaultTimeout(15000);
            motionPage.on('pageerror',error=>errors.push({role:'startup',error:error.message}));
            await motionPage.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==ctx.stack.origin){external.push(url.origin);return route.abort();}return route.continue();});
            await motionPage.clock.install({time:new Date('2026-10-15T18:00:00Z')});await motionPage.clock.pauseAt(new Date('2026-10-15T18:00:01Z'));
            await motionPage.goto(ctx.stack.origin);await motionPage.locator('#startup-wordmark').waitFor({state:'visible'});await motionPage.evaluate(()=>document.fonts.ready);
            await motionPage.locator('.auth-lambda').evaluate(node=>{const animation=node.getAnimations()[0];animation.pause();animation.currentTime=300;});
            await motionPage.screenshot({path:join(screens,'startup-1440.png')});await motionPage.locator('#startup-wordmark').click();
            const skipped=await motionPage.locator('#startup-wordmark').isHidden();await motionPage.reload();await motionPage.locator('[data-nav=resources][aria-current=page]').waitFor();
            const replayed=await motionPage.locator('#startup-wordmark').isVisible();checks.push(['原 R5 字标开场',async()=>{ctx.check('开场可跳过',skipped);ctx.check('同会话不重播且进入算力',!replayed);}]);
          }finally{await motionContext.close();}
        }
        if(role==='member'){
          await page.locator('#announcement-dialog').waitFor({state:'visible'});await page.locator('#announcement-title').filter({hasText:'灰度网页定向弹窗'}).waitFor();
          checks.push(['A 实际看到定向弹窗',async()=>ctx.check('A 实际看到定向弹窗',true)]);
          await page.screenshot({path:join(screens,'member-announcement.png'),fullPage:true});await page.locator('#announcement-ack').click();await page.locator('#announcement-dialog').waitFor({state:'hidden'});
        }
        for(const width of [1440,390,320]){
          await page.setViewportSize({width,height:1000});
          for(const [label,route,button] of [['resources','resources','[data-nav=resources]'],['projects','work','#projects-refresh'],['jobs','jobs','#my-job-table'],['datasets','datasets','#dataset-upload-form'],['community','community','[data-nav=community]']]){
            const title=role+'/'+width+'/'+label;
            try{
              await page.evaluate(hash=>{location.hash='#'+hash;},route);await page.locator('#page-'+(route==='jobs'?'work':route)).waitFor({state:'visible'});
              await page.locator(button).evaluate(element=>{for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;});
              await page.locator(button).scrollIntoViewIfNeeded();await page.evaluate(()=>document.fonts.ready);
              const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),visible=await page.locator(button).isVisible();
              await page.screenshot({path:join(screens,role+'-'+width+'-'+label+'.png'),fullPage:true,animations:'disabled'});
              checks.push([title,async()=>{ctx.check(title+' 无横向滚动',!overflow);ctx.check(title+' 主要入口可见',visible);}]);
            }catch(error){checks.push([title,async()=>{throw error;}]);}
          }
          await page.locator('#account-menu-toggle').click();await page.locator('[data-shell-action=quota]').click();await page.locator('#quota-ledger').waitFor();
          const navCount=await page.locator('#room-nav [data-nav]').count(),commandCount=await page.locator('[data-shell-action=control]').count(),retiredCount=await page.locator('#control-strip,#mobile-control,#shell-context').count();
          const targets=await page.locator('#room-nav a,#account-menu-toggle,.command-trigger').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height};}));
          checks.push([role+'/'+width+'/shell',async()=>{
            ctx.check('五个主区入口',navCount===5);ctx.check('全局命令入口只有一个',commandCount===1);ctx.check('浮动条与顶部上下文条已移除',retiredCount===0);ctx.check('导航触控区域至少 44px',targets.every(r=>r.width>=44&&r.height>=44),targets);
          }]);
          await page.locator('#account-menu-toggle').click();
          const adminEntry=await page.locator('[data-shell-action=admin]').isVisible();checks.push([role+' 管理入口',async()=>ctx.check('管理台入口按角色显示',adminEntry===(role==='admin'))]);
          await page.screenshot({path:join(screens,role+'-'+width+'-account.png'),fullPage:true,animations:'disabled'});await page.keyboard.press('Escape');
          await page.locator('.command-trigger').click();await page.locator('#control-command').fill('火星');await page.locator('.palette-egg').waitFor();
          await page.screenshot({path:join(screens,role+'-'+width+'-palette.png'),animations:'disabled'});
          await page.locator('#control-command').fill('月球');await page.locator('.egg-moon').waitFor();await page.keyboard.press('Escape');
          await page.goto(ctx.stack.origin+'/guide');await page.screenshot({path:join(screens,role+'-'+width+'-guide.png'),fullPage:true});
          const guide=await page.locator('body').innerText(),chapters=await page.locator('.guide-card').count(),guideOverflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);checks.push([role+'/'+width+'/guide',async()=>{ctx.check('使用指南与七章入口可读',guide.includes('STARGATE')&&guide.includes('使用指南')&&chapters===7);ctx.check('指南无横向滚动',!guideOverflow);}]);
          await page.goto(ctx.stack.origin+'/#work');await page.locator('[data-nav=work][aria-current=page]').waitFor();
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
