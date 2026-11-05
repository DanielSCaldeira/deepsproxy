.PHONY: help setup install playwright build test run start continue-config docker-up docker-down docker-logs preview test-live-context live live-stop live-status live-logs live-workers live-worker-logs clean

help:
	@echo "Comandos disponíveis:"
	@echo "  make setup        - Instala dependências e Chromium do Playwright"
	@echo "  make install      - Instala dependências Node"
	@echo "  make playwright   - Instala Chromium do Playwright"
	@echo "  make build        - Compila TypeScript"
	@echo "  make test         - Executa testes"
	@echo "  make run          - Inicia o proxy local (http://localhost:3000/v1)"
	@echo "  make start        - Inicialização completa (setup + run). Login das contas: painel do make live"
	@echo "  make continue-config - Copia a configuracao pronta para a extensao Continue"
	@echo "  make docker-up    - Sobe com docker compose"
	@echo "  make docker-down  - Derruba docker compose"
	@echo "  make docker-logs  - Acompanha logs do docker compose"
	@echo "  make preview      - Abre preview local do painel"
	@echo "  make test-live-context - Smoke test do resumo de contexto"
	@echo "  make live         - Build + sobe ambiente de teste real (painel: http://localhost:3440)"
	@echo "  make live-stop    - Para o ambiente real local e os navegadores (workers)"
	@echo "  make live-status  - Mostra os containers do ambiente real local"
	@echo "  make live-logs    - Acompanha logs do gateway e do provisioner"
	@echo "  make live-workers - Lista os navegadores (workers) ativos"
	@echo "  make live-worker-logs - Acompanha logs dos navegadores (workers)"
	@echo "  make clean        - Remove build e cache local"

setup: install playwright

install:
	npm install

playwright:
	npx playwright install chromium

build:
	npm run build

test:
	npm test

run:
	npm run start

start: setup run

continue-config:
	node -e "const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os'); const src=path.resolve('continue.config.yaml'); const dir=path.join(os.homedir(),'.continue'); const dest=path.join(dir,'config.yaml'); if(!fs.existsSync(src)){throw new Error('Arquivo continue.config.yaml nao encontrado.');} fs.mkdirSync(dir,{recursive:true}); if(fs.existsSync(dest)){const stamp=new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14); const backup=path.join(dir,'config.yaml.bak-'+stamp); fs.copyFileSync(dest,backup); console.log('Backup criado:', backup);} fs.copyFileSync(src,dest); console.log('Configuracao do Continue copiada para:', dest); console.log('Recarregue o VS Code com Developer: Reload Window.');"

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

preview:
	npm run preview

test-live-context:
	npm run test:live-context

live:
	npm run live

live-stop:
	npm run live:stop

live-status:
	npm run live:status

live-logs:
	docker compose --env-file .cache/proxy-ia-live.env -f compose.live.yml logs -f --tail 100 gateway provisioner

live-workers:
	docker ps -a --filter label=dsp_live.managed=worker --format "table {{.Names}}	{{.Status}}	{{.Label \"dsp_live.provider\"}}"

live-worker-logs:
	node -e "const cp=require('node:child_process'); const ids=cp.execSync('docker ps -q --filter label=dsp_live.managed=worker',{encoding:'utf8'}).trim().split(/\s+/).filter(Boolean); if(!ids.length){console.log('Nenhum navegador (worker) ativo.'); process.exit(0);} for(const id of ids) cp.spawn('docker',['logs','-f','--tail','50',id],{stdio:'inherit'});"

clean:
	node -e "const fs=require('node:fs'); ['dist','.turbo','.cache'].forEach((d)=>{if(fs.existsSync(d)){fs.rmSync(d,{recursive:true,force:true}); console.log('Removido:', d);}});"
