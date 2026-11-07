import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { panelPage } from './production/panel.ts';

test('API panel: masked key, free models, validation, removal and mobile',async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on('pageerror',e => errors.push(e.message));
    const script = await readFile(new URL('../public/panel.js',import.meta.url),'utf8');
    let configured = false, validated = false, saved = '', logout = false, saves = 0;
    const model = 'openrouter/fixture/text:free';
    await page.route('https://proxy.test/**',async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      const json = (body: unknown,status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      if (path === '/') return route.fulfill({contentType:'text/html',body:panelPage});
      if (path === '/assets/panel.js') return route.fulfill({contentType:'text/javascript',body:script});
      if (path === '/api/auth/logout') { logout = true; return json({ok:true}); }
      if (path === '/api/me') return json({id:'fixture',email:'user@test.com',role:'user',csrf:'fixture-csrf'});
      if (path === '/api/me/accounts') return json({accounts:[],apiConnections:[{provider:'openrouter',name:'OpenRouter API',enabled:true,configured,maskedSuffix:'1234',validatedAt:validated ? '2026-11-07T12:00:00Z' : null,models:configured ? [{id:model}] : []}]});
      if (path === '/api/me/keys') return json({keys:[]});
      if (path === '/api/me/provider-credentials/openrouter') {
        if (method === 'PUT') { saves++; saved = route.request().postDataJSON().apiKey; configured = true; validated = false; }
        if (method === 'DELETE') configured = false;
        return json({ok:true});
      }
      if (path.endsWith('/validate')) { assert.equal(route.request().postDataJSON().model,model); validated = true; return json({ok:true}); }
      if (path.endsWith('/limits')) return json({daily:{used:1,remaining:49,limit:50}});
      return json({ok:true});
    });
    await page.goto('https://proxy.test');
    const card = page.locator('[data-api-provider=openrouter]');
    await card.getByText('Nenhuma chave cadastrada.',{exact:true}).waitFor();
    const dummy = 'sk-or-fixture-only-1234';
    await card.getByLabel('Chave OpenRouter API').fill(dummy);
    await card.getByRole('button',{name:'Salvar chave',exact:true}).click();
    await card.getByText('Chave …1234',{exact:false}).waitFor(); assert.equal(saved,dummy);
    assert.equal(await card.getByLabel('Chave OpenRouter API').inputValue(),'************');
    await card.getByRole('button',{name:'Substituir chave',exact:true}).click();
    await page.locator('#message').filter({hasText:'A chave já está salva.'}).waitFor();
    assert.equal(saves,1);
    await card.getByLabel('Chave OpenRouter API').focus();
    assert.equal(await card.getByLabel('Chave OpenRouter API').inputValue(),'');
    await card.getByLabel('Chave OpenRouter API').blur();
    assert.equal(await card.getByLabel('Chave OpenRouter API').inputValue(),'************');
    assert.ok(!(await card.textContent())?.includes(dummy));
    assert.deepEqual(await card.locator('option').allTextContents(),[model]);
    await card.getByRole('button',{name:'Validar geração gratuita'}).click();
    await card.getByText('Geração validada em',{exact:false}).waitFor();
    await card.getByRole('button',{name:'Consultar cota'}).click(); await page.locator('#message').filter({hasText:'Cota diária: 49 restantes de 50 chamadas.'}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await mkdir('.cache',{recursive:true}); await page.screenshot({path:'.cache/free-api-panel-mobile.png',fullPage:true});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await card.getByRole('button',{name:'Remover chave'}).click(); await card.getByText('Nenhuma chave cadastrada.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Sair',exact:true}).click(); assert.ok(logout);
    assert.equal(await page.locator('#api-connections').textContent(),''); assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
