.PHONY: help setup install playwright login build test run start continue-config docker-up docker-down docker-logs clean

help:
	@echo "Comandos disponíveis:"
	@echo "  make setup        - Instala dependências e Chromium do Playwright"
	@echo "  make install      - Instala dependências Node"
	@echo "  make playwright   - Instala Chromium do Playwright"
	@echo "  make login        - Abre login interativo no DeepSeek"
	@echo "  make build        - Compila TypeScript"
	@echo "  make test         - Executa testes"
	@echo "  make run          - Inicia o proxy"
	@echo "  make start        - Inicialização completa (setup + login se necessário + run)"
	@echo "  make continue-config - Copia a configuracao pronta para a extensao Continue"
	@echo "  make docker-up    - Sobe com docker compose"
	@echo "  make docker-down  - Derruba docker compose"
	@echo "  make docker-logs  - Acompanha logs do docker compose"
	@echo "  make clean        - Remove build e cache local"

setup: install playwright

install:
	npm install

playwright:
	npx playwright install chromium

login:
	npm run login

build:
	npm run build

test:
	npm test

run:
	npm run start

start: setup
	node -e "const fs=require('node:fs'); const cp=require('node:child_process'); const hasProfile=fs.existsSync('deepseek_profile/Default'); if(!hasProfile){console.log('Perfil do DeepSeek nao encontrado. Iniciando login interativo...'); cp.execSync('npm run login',{stdio:'inherit'});} console.log('Iniciando DeepsProxy...'); cp.execSync('npm run start',{stdio:'inherit'});"

continue-config:
	node -e "const fs=require('node:fs'); const path=require('node:path'); const os=require('node:os'); const src=path.resolve('continue.config.yaml'); const dir=path.join(os.homedir(),'.continue'); const dest=path.join(dir,'config.yaml'); if(!fs.existsSync(src)){throw new Error('Arquivo continue.config.yaml nao encontrado.');} fs.mkdirSync(dir,{recursive:true}); if(fs.existsSync(dest)){const stamp=new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14); const backup=path.join(dir,'config.yaml.bak-'+stamp); fs.copyFileSync(dest,backup); console.log('Backup criado:', backup);} fs.copyFileSync(src,dest); console.log('Configuracao do Continue copiada para:', dest); console.log('Recarregue o VS Code com Developer: Reload Window.');"

docker-up:
	docker compose up -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

clean:
	node -e "const fs=require('node:fs'); ['dist','.turbo','.cache'].forEach((d)=>{if(fs.existsSync(d)){fs.rmSync(d,{recursive:true,force:true}); console.log('Removido:', d);}});"
