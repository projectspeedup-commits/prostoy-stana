import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fullNameError } from '../../app/public/queue.js';
import { computeStats } from '../../app/core/stats.js';
import { DEFAULT_SCHEDULE } from '../../app/core/core.js';

test('Раунд 2.18: ФИО — расширенная кириллица, понятный отказ и общий лимит 120', () => {
  assert.equal(fullNameError(['Әлімқұлов', 'Ғалымжан', 'Нұрұлы']), '');
  assert.equal(fullNameError(['Һаһов', 'Ілияс', 'Өлеңович']), '');
  assert.equal(fullNameError(['Иванов', 'Иван', 'Иванович']), '');
  assert.match(fullNameError(['Иванов', 'И.', 'Иванович']), /без точек и цифр/);
  assert.match(fullNameError(['Иванов', 'Иван2', 'Иванович']), /без точек и цифр/);
  assert.equal(fullNameError(['А'.repeat(40), 'Б'.repeat(39), 'В'.repeat(39)]), '');
  assert.match(fullNameError(['А'.repeat(40), 'Б'.repeat(40), 'В'.repeat(39)]), /120/);
});

test('Раунд 2.18: по сменам — цветные зоны с точным итогом, включая доли минуты', () => {
  const nowMs=Date.parse('2026-10-05T08:00:00Z'), fromMs=nowMs-3600000;
  const refs={settings:{schedule:DEFAULT_SCHEDULE,shortStopMinutes:5},reasons:{p:{planned:true,zone:'plan'},u:{zone:'unplanned'},f:{zone:'failure'}}};
  const events=[{id:'crew',type:'shift_open',crewId:'1',at:fromMs}, ...['p','u','f'].map((reason,i)=>({id:reason,type:'manual',at:fromMs+i*60000,from:fromMs+i*60000,to:fromMs+i*60000+36000,reason,crewId:'1'}))];
  const st=computeStats(events,{fromMs,toMs:nowMs,nowMs,refs});
  assert.equal(st.downMin,2);
  assert.deepEqual(st.byCrew[0].byZone.map(x=>x.zone),['plan','unplanned','failure']);
  assert.equal(st.byCrew[0].byZone.reduce((n,x)=>n+x.minutes,0),st.byCrew[0].minutes);
  assert.equal(st.byCrew[0].minutes,st.downMin);
});
