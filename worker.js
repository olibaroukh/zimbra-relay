// Relais Zimbra pour bilan-passage + repartition_stocks.html — Olivier Baroukh / Optical Center
// Ce Worker retransmet les appels SOAP et l'upload de pièce jointe vers Zimbra
// à côté serveur, pour contourner le blocage CORS du navigateur.
// Il persiste aussi une copie structurée de chaque bilan dans D1 (routes /store-bilan, /bilans)
// pour alimenter l'analyse centralisée, indépendante du localStorage de chaque animateur.

const ALLOWED_ORIGIN = 'https://olibaroukh.github.io';
const ZIMBRA_SOAP_URL = 'https://zimbra.oc-pratique.com/service/soap';
const ZIMBRA_UPLOAD_URL = 'https://zimbra.oc-pratique.com/service/upload?fmt=raw';

// Token secret pour sécuriser la route /notify
// À changer si compromis — doit correspondre à NOTIFY_SECRET dans index.html
const NOTIFY_SECRET = 'OC-bilan-notify-2026';

// Token secret pour sécuriser les routes de persistance D1 (/store-bilan, /bilans)
// À changer si compromis — doit correspondre à STORE_SECRET dans index.html / dashboard
const STORE_SECRET = 'OC-bilan-store-2026';

// Clé de signature interne des sessions animateur (HMAC), jamais exposée côté client
const AR_SESSION_SECRET = 'OC-bilan-arsession-2026-signing-key';
const AR_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// ---------- Accompagnement Manager (08/09) ----------
// Un seul itinérant pour l'instant (Emilie) — liste à étendre ici quand
// d'autres itinérants rejoindront, sans nouvelle colonne magasins.csv.
const ACCOMP_SESSION_SECRET = 'OC-accomp-arsession-2026-signing-key';
const ACCOMP_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h, même convention que /ar-login
const ACCOMP_ALLOWED_EMAILS = ['emilie.nahon@optical-center.com', 'olivier.baroukh@optical-center.com'];
const MAGASINS_CSV_URL = 'https://raw.githubusercontent.com/olibaroukh/bilan-passage/main/magasins.csv';
const KAIZEN_REFERENTIEL_URL = 'https://raw.githubusercontent.com/olibaroukh/kaizen/main/kaizen-referentiel.json';
const KAIZEN_POINTS_PAR_ITEM = 0.5;

// ---------- Indicateur RH — import mensuel (19/08) ----------
// Mapping poste -> catégorie effectif (2 catégories, confirmé par Olivier le 19/08).
// Comparaison insensible à la casse (l'export a varié entre "contactologue" et "Contactologue").
const RH_POSTE_AUDIO = ['audioprothésiste', 'technicien audio'];
const RH_POSTE_OPTICIEN = ['manager', 'monteur', 'opticien/vendeur', 'optométriste/contactologue'];

function rhMapPosteCategorie(poste) {
  const p = (poste || '').trim().toLowerCase();
  if (RH_POSTE_AUDIO.includes(p)) return 'audio';
  if (RH_POSTE_OPTICIEN.includes(p)) return 'opticien';
  return null; // hors périmètre magasin (siège, logistique, animateur réseau, etc.)
}

// Un code site RH ("Codes sites", ex: "001020") correspond au code magasins.csv
// ("1020") une fois les zéros de tête retirés — vérifié sur les exports réels
// juin/juillet 2026 (ex: matricule 3381, "001020" == magasin 1020 "NATION -
// CHARONNE - 20ÈME"). `reconnu` reste false si le code résultant n'existe pas
// dans magasins.csv (magasin fermé, siège "001900", etc.) — ne bloque pas
// l'import, juste remonté à l'écran pour info.
function rhMapCodeSiteVersMagasin(codeRh, magasinsCodesSet) {
  const n = parseInt(String(codeRh || '').trim(), 10);
  if (!Number.isFinite(n)) return { code: null, reconnu: false };
  const code = String(n);
  return { code, reconnu: magasinsCodesSet.has(code) };
}

function rhNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function rhJoursDansMois(mois) {
  const [y, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function rhMoisPrecedent(mois) {
  const [y, m] = mois.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

// Colonnes de l'export "Rapport agenda validés" — groupes A/B validés par
// Olivier le 19/08 (voir doc "besoin-rh-paie-indicateur-sante.md" du projet).
// Chômage Partiel volontairement absent des 2 groupes (plus utilisé depuis le Covid).
const RH_GROUPE_A_COLS = [
  'Absence maladie', 'Absence maladie (Alsace Moselle)',
  'Absence Accident Travail', 'Absence Accident Travail (Alsace Moselle)',
  'Absence non payée', 'Congés sans solde',
  'Congé maternité', 'Congé paternité', 'Congé Parental',
  'Naissance', 'Mariage/Pacs',
];

const RH_GROUPE_B_COLS = [
  'Congé Performance', 'Congés Ancienneté', 'Congé Supplémentaire Naissance',
  'Congés payes', 'Repos Anniversaire', 'Décès', 'Déduction Entrée', 'Déduction Sortie',
  'Evènement religieux', 'Férié', 'Garde Enfants', 'Jour de fermeture', 'Journée école',
  'Temps partiel Thérapeutique', 'Récupération', 'Repos hebdomadaire', 'Repos temps partiel',
];

// Pour la règle "longue durée" : maladie/AT sur 2 mois consécutifs.
const RH_MALADIE_AT_COLS = [
  'Absence maladie', 'Absence maladie (Alsace Moselle)',
  'Absence Accident Travail', 'Absence Accident Travail (Alsace Moselle)',
];

// Pour la règle "longue durée" : maternité/parental/paternité déclenche direct.
const RH_MATERNITE_PARENTAL_COLS = ['Congé maternité', 'Congé paternité', 'Congé Parental'];

function rhSommeColonnes(row, cols) {
  return cols.reduce((acc, c) => acc + rhNum(row[c]), 0);
}

// ---------- Indicateur RH — impact sur le score de santé (phase 2, 19/08) ----------
// Calcul discuté et validé avec Olivier le 19/08 (voir doc projet
// "besoin-rh-paie-indicateur-sante.md") :
// - sous-effectif soutenu : intégré au sous-score "effectif" existant, ne
//   pénalise que si le magasin est en sous-effectif réel (RH, longue durée
//   exclue de l'effectif disponible) sur 3 mois calendaires CONSÉCUTIFS. Le
//   sur-effectif (déclaratif, bilan de passage) n'est pas touché.
// - absentéisme : nouvelle dimension. Taux du mois = jours groupe A (longue
//   durée INCLUSE, choix d'Olivier pour rester simple) / jours ouvrés
//   théoriques, pondéré par site pour le multi-sites. Note du mois =
//   100 - taux*100. Le sous-score final est la moyenne des notes mensuelles
//   sur tous les mois pour lesquels le magasin a des données RH (fenêtre qui
//   grandit avec l'historique, pas figée à 3 mois comme le sous-effectif).

function rhMoisConsecutifs(moisTries) {
  for (let i = 1; i < moisTries.length; i++) {
    if (rhMoisPrecedent(moisTries[i]) !== moisTries[i - 1]) return false;
  }
  return true;
}

let _rhHealthSignalsCache = null;
let _rhHealthSignalsCacheAt = 0;

// Un seul passage sur toute la donnée RH dispo (tous mois confondus), agrégé
// par magasin et par mois — réutilisé ensuite pour chaque magasin dans
// buildStoreHealthResults() plutôt que refaire une requête par magasin.
// Cache 5 min : cette fonction est appelée à chaque /store-health (donc à
// chaque chargement de l'onglet Tournée), pas seulement au cron hebdo.
async function getRhHealthSignalsMap(env) {
  if (!env.DB) return {};
  const now = Date.now();
  if (_rhHealthSignalsCache && (now - _rhHealthSignalsCacheAt) < 5 * 60 * 1000) return _rhHealthSignalsCache;

  let results;
  try {
    ({ results } = await env.DB.prepare(`
      SELECT
        es.mois as mois,
        es.code_site as code_site,
        SUM(es.poids) as effectif_total,
        SUM(CASE WHEN a.longue_duree = 1 THEN es.poids ELSE 0 END) as effectif_longue_duree,
        SUM(a.jours_groupe_a * es.poids) as groupe_a_pondere,
        SUM(a.jours_ouvres_theoriques * es.poids) as theo_pondere
      FROM rh_effectif_site_mensuel es
      JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
      WHERE es.site_reconnu = 1
      GROUP BY es.mois, es.code_site
      ORDER BY es.mois ASC
    `).all());
  } catch(e) { console.error('Erreur lecture signaux RH (santé) :', e); return {}; }

  const parMagasin = {};
  for (const r of results) {
    (parMagasin[r.code_site] ??= []).push({
      mois: r.mois,
      effectifDispo: r.effectif_total - r.effectif_longue_duree,
      tauxAbsenteisme: r.theo_pondere > 0 ? (r.groupe_a_pondere / r.theo_pondere) : null,
    });
  }

  const map = {};
  for (const [code, moisArr] of Object.entries(parMagasin)) {
    const notes = moisArr.filter(m => m.tauxAbsenteisme !== null).map(m => Math.max(0, 100 - m.tauxAbsenteisme * 100));
    const absenteismeScore = notes.length ? Math.round((notes.reduce((a, b) => a + b, 0) / notes.length) * 10) / 10 : null;
    const derniers3 = moisArr.slice(-3);
    const consecutifs = derniers3.length === 3 && rhMoisConsecutifs(derniers3.map(m => m.mois));
    // Dernier mois RH connu, indépendamment de la règle des 3 mois consécutifs
    // (qui ne sert qu'à la pénalité "soutenu") — sert de repli pour le
    // sous-score effectif quand un magasin n'a pas de bilan de passage
    // exploitable (cas Lille, 19/08) : mieux vaut la donnée RH réelle du
    // dernier mois que "pas de données".
    const dernierMois = moisArr.length ? moisArr[moisArr.length - 1] : null;
    map[code] = { derniers3, consecutifs, absenteismeScore, moisCount: notes.length, dernierMois };
  }
  _rhHealthSignalsCache = map;
  _rhHealthSignalsCacheAt = now;
  return map;
}

// effTheo vient de magasins.csv (voir getMagasinsServerSide, 19/08) — pas de
// comparaison possible sans lui.
function computeEffectifRH(rhSignal, effTheo) {
  if (!rhSignal || !rhSignal.consecutifs || effTheo === null || effTheo === undefined) {
    return { soutenu: false, ecartMoyen: null };
  }
  const ecarts = rhSignal.derniers3.map(m => m.effectifDispo - effTheo);
  const soutenu = ecarts.every(e => e < 0);
  const ecartMoyen = soutenu ? Math.round((ecarts.reduce((a, b) => a + b, 0) / ecarts.length) * 10) / 10 : null;
  return { soutenu, ecartMoyen };
}
// ---------- Fin indicateur RH ----------

// Taille des lots pour le refresh des notes Google (reste sous la limite de 50
// sous-requêtes externes du plan gratuit Workers). Le cron tourne 3x/semaine
// (MON/WED/FRI) et fait tourner un curseur en D1 pour couvrir tous les magasins.
const GOOGLE_RATINGS_BATCH_SIZE = 40;

// Alias manuels pour des noms reçus via les imports "Pour être dans le vert"
// que ni normalizeName() ni une suggestion automatique ne peuvent rapprocher
// de façon fiable du libellé officiel dans magasins.csv (écart trop grand,
// nom source qui ne suivra jamais le motif standard). Identifiés au cas par
// cas par Olivier — ne pas essayer de deviner, ajouter une entrée ici
// uniquement une fois le magasin réel confirmé.
// `recu` = texte exact tel qu'il arrive (sera normalisé au moment de l'usage) ;
// `code` = code magasin réel dans magasins.csv.
const STORE_STATS_NAME_ALIASES = [
{ recu: 'Bd St Germain', code: '1117' }, // -> BD SAINT-GERMAIN - 5ème (confirmé par Olivier le 16/08)
];

let _magasinsCache = null;
let _magasinsCacheAt = 0;

async function getMagasinsServerSide() {
const now = Date.now();
if (_magasinsCache && (now - _magasinsCacheAt) < 10 * 60 * 1000) return _magasinsCache;
const resp = await fetch(MAGASINS_CSV_URL + '?v=' + now);
const text = await resp.text();
const lines = text.split(/\r?\n/).filter(Boolean);
const header = lines[0].split(';').map(h => h.trim());
const idxAnimateur = header.indexOf('animateur');
const idxCode = header.indexOf('code');
const idxLibelle = header.indexOf('libelle');
const idxEmail = header.indexOf('animateur_email');
const idxStoreEmail = header.indexOf('email');
const idxPlaceId = header.indexOf('google_place_id');
const idxConcept = header.indexOf('concept');
const idxMeubleVitrine = header.indexOf('meuble_vitrine');
const idxPresentoirVerres = header.indexOf('presentoir_verres');
// eff_theo (effectif théorique) : géré par Olivier directement dans ce fichier,
// jamais saisi par l'AR (contrairement à eff_opt/eff_audio, confirmés/corrigés
// à chaque bilan de passage). Lu ici en direct plutôt que via la copie figée
// dans le dernier bilan, pour rester à jour même sans visite récente (19/08,
// suite au cas Lille : "pas de données" alors que l'effectif RH était connu).
const idxEffTheo = header.indexOf('eff_theo');
const idxManager = header.indexOf('manager');
const idxObjectifAnnuel = header.indexOf('Objectif Annuel');
const rows = lines.slice(1).map(line => {
const cols = line.split(';');
const effTheoRaw = idxEffTheo >= 0 ? (cols[idxEffTheo] || '').trim() : '';
const effTheoNum = effTheoRaw ? parseFloat(effTheoRaw.replace(',', '.')) : NaN;
const objAnnuelRaw = idxObjectifAnnuel >= 0 ? (cols[idxObjectifAnnuel] || '').trim() : '';
const objAnnuelNum = objAnnuelRaw ? parseFloat(objAnnuelRaw.replace(',', '.')) : NaN;
return {
code: (cols[idxCode] || '').trim(),
libelle: idxLibelle >= 0 ? (cols[idxLibelle] || '').trim() : '',
animateur: (cols[idxAnimateur] || '').trim(),
animateurEmail: idxEmail >= 0 ? (cols[idxEmail] || '').trim() : '',
email: idxStoreEmail >= 0 ? (cols[idxStoreEmail] || '').trim() : '',
googlePlaceId: idxPlaceId >= 0 ? (cols[idxPlaceId] || '').trim() : '',
concept: idxConcept >= 0 ? (cols[idxConcept] || '').trim() : '',
meubleVitrine: idxMeubleVitrine >= 0 ? /^(oui|1|true)$/i.test((cols[idxMeubleVitrine] || '').trim()) : false,
presentoirVerres: idxPresentoirVerres >= 0 ? /^(oui|1|true)$/i.test((cols[idxPresentoirVerres] || '').trim()) : false,
effTheo: Number.isFinite(effTheoNum) ? effTheoNum : null,
manager: idxManager >= 0 ? (cols[idxManager] || '').trim() : '',
// En k€, saisi une fois par an par Olivier — sert de base au calcul du CA
// prévisionnel annuel (objectifAnnuel × positionnement annuel).
objectifAnnuel: Number.isFinite(objAnnuelNum) ? objAnnuelNum : null,
};
}).filter(r => r.code);
_magasinsCache = rows;
_magasinsCacheAt = now;
return rows;
}

// --- Kaizen : référentiel de zones/items (statique, hébergé sur GitHub, changements rares) ---
let _kaizenRefCache = null;
let _kaizenRefCacheAt = 0;

async function getKaizenReferentiel() {
const now = Date.now();
if (_kaizenRefCache && (now - _kaizenRefCacheAt) < 10 * 60 * 1000) return _kaizenRefCache;
const resp = await fetch(KAIZEN_REFERENTIEL_URL + '?v=' + now);
const zones = await resp.json();
_kaizenRefCache = zones;
_kaizenRefCacheAt = now;
return zones;
}

// Aplatit le référentiel en une liste d'items filtrée selon le concept du magasin
// (les items marqués Ancien/UDM ne sont retenus que pour le concept correspondant,
// les items "Tous" sont toujours retenus). Les items optionnels (ex. Meuble Vitrine)
// sont exclus du calcul de score mais restent affichables si le magasin les a.
function kaizenItemsApplicables(zones, concept) {
const conceptNorm = (concept || '').trim().toLowerCase();
const out = [];
for (const zone of zones) {
for (const secteur of zone.secteurs) {
for (const item of secteur.items) {
const itemConceptNorm = (item.concept || 'Tous').trim().toLowerCase();
const concernePasConcept = itemConceptNorm === 'tous' || itemConceptNorm === conceptNorm;
if (!concernePasConcept) continue;
out.push({ ...item, zoneNumero: zone.numero, zoneNom: zone.nom, secteurNom: secteur.nom || null });
}
}
}
return out;
}

function kaizenComputeScore(itemsState, itemsApplicables) {
const notes = itemsApplicables.filter(i => !i.optional);
const scoreMax = notes.length * KAIZEN_POINTS_PAR_ITEM;
let score = 0;
for (const item of notes) {
if (itemsState?.[item.id]?.checked) score += KAIZEN_POINTS_PAR_ITEM;
}
return { score: Math.round(score * 10) / 10, scoreMax: Math.round(scoreMax * 10) / 10 };
}

function moisPrecedent(dateRef) {
const d = dateRef ? new Date(dateRef) : new Date();
d.setUTCDate(1);
d.setUTCMonth(d.getUTCMonth() - 1);
return d.toISOString().slice(0, 7); // "YYYY-MM"
}

function moisLabelKaizen(moisStr) {
const [y, m] = moisStr.split('-').map(Number);
const noms = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
return `${noms[m - 1]} ${y}`;
}

// --- Kaizen : suivi des points non conformes qui traînent d'un mois à l'autre ---
// (ajouté 16/08/2026). items_json est déjà stocké par magasin/mois dans
// kaizen_audits — rien de nouveau à collecter, juste à comparer les mois entre
// eux. Une seule requête groupée sur plusieurs mois (pas une requête par item/
// magasin) pour rester très en dessous des limites de sous-requêtes Workers.

// Historique des items_json Kaizen sur les `lookbackMonths` derniers mois
// (moisCourant inclus), tous magasins confondus. Retourne { history, moisListe }
// où history = { magasin_code: { mois: itemsState } } et moisListe[0] = moisCourant.
async function getKaizenItemsHistory(env, moisCourant, lookbackMonths = 6) {
if (!env.DB) return { history: {}, moisListe: [moisCourant] };
const moisListe = [moisCourant];
for (let i = 1; i < lookbackMonths; i++) moisListe.push(moisPrecedent(moisListe[moisListe.length - 1]));
const placeholders = moisListe.map(() => '?').join(',');
const { results } = await env.DB.prepare(
`SELECT magasin_code, mois, items_json FROM kaizen_audits WHERE mois IN (${placeholders})`
).bind(...moisListe).all();
const history = {};
results.forEach(r => {
let itemsState = {};
try { itemsState = JSON.parse(r.items_json || '{}'); } catch(e) {}
(history[r.magasin_code] ??= {})[r.mois] = itemsState;
});
return { history, moisListe };
}

// Combien de mois consécutifs AVANT moisCourant (donc sans compter le mois
// qu'on est en train de clôturer) cet item était déjà non conforme pour ce
// magasin. S'arrête au premier mois sans audit, où l'item est absent de
// l'audit (référentiel/concept différent ce mois-là — on ne devine jamais),
// ou où il était conforme.
function computeItemStreak(history, moisListe, magasinCode, itemId) {
let streak = 0;
for (let i = 1; i < moisListe.length; i++) {
const itemsState = history[magasinCode]?.[moisListe[i]];
if (!itemsState || !(itemId in itemsState)) break;
if (itemsState[itemId]?.checked) break;
streak++;
}
return streak;
}

// Items non conformes ce mois-ci qui l'étaient déjà depuis au moins `threshold`
// mois consécutifs avant celui-ci (donc non résolus depuis 2 mois ou plus au total).
function computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, history, moisListe, magasinCode, threshold = 1) {
const out = [];
itemsApplicables.filter(i => !i.optional).forEach(item => {
if (itemsStateThisMonth?.[item.id]?.checked) return;
const streak = computeItemStreak(history, moisListe, magasinCode, item.id);
if (streak >= threshold) {
out.push({ label: item.label, zoneNom: item.zoneNom, moisConsecutifs: streak + 1 });
}
});
return out;
}

function htmlStuckKaizenItemsSection(items, scopeLabel) {
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">🔁 Points Kaizen non résolus depuis plusieurs mois</h3>`;
if (!items.length) {
return title + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun point Kaizen non résolu depuis plusieurs mois ${scopeLabel}. ✅</p>`;
}
return title + htmlStatsTable(
['Magasin', 'Animateur', 'Point non conforme', 'Zone', 'Depuis combien de mois'],
items.map(i => [i.libelle, i.animateur, i.itemLabel, i.zoneNom || '—', i.moisConsecutifs])
);
}

// Simule la clôture pour un mois donné, SANS rien écrire en D1 et SANS envoyer d'email.
// Sert de mode "preview" pour la route de test manuelle /test-kaizen-cloture.
async function previewCloturesKaizen(env, moisOverride) {
if (!env.DB) throw new Error('Base D1 non liée au Worker');
const mois = moisOverride || moisPrecedent();
const stores = await getMagasinsServerSide();

const { results: aCloturer } = await env.DB.prepare(
`SELECT * FROM kaizen_audits WHERE mois = ? AND closed = 0`
).bind(mois).all();

const preview = [];
for (const audit of aCloturer) {
const store = stores.find(s => s.code === audit.magasin_code);
const libelle = store ? store.libelle : audit.magasin_code;

const { results: histo } = await env.DB.prepare(
`SELECT score FROM kaizen_audits WHERE magasin_code = ? AND mois LIKE ?`
).bind(audit.magasin_code, mois.slice(0, 4) + '-%').all();
const cumulAnnuel = Math.round(histo.reduce((s, r) => s + (r.score || 0), 0) * 10) / 10;

const destinataires = [OLIVIER_EMAIL];
if (store?.animateurEmail) destinataires.push(store.animateurEmail);

preview.push({
magasinCode: audit.magasin_code,
libelle,
score: audit.score,
scoreMax: audit.score_max,
cumulAnnuelApresCloture: cumulAnnuel,
destinataires,
sujetEmail: `Kaizen ${libelle} — clôture ${moisLabelKaizen(mois)}`,
});
}

const { results: dejaClotures } = await env.DB.prepare(
`SELECT magasin_code, score, score_max, closed_at FROM kaizen_audits WHERE mois = ? AND closed = 1`
).bind(mois).all();

return { mois, moisLabel: moisLabelKaizen(mois), aCloturer: preview, totalACloturer: preview.length, dejaClotures };
}

// Clôture Kaizen — un seul récap par AR (ses magasins) + un seul récap réseau
// (Olivier), plutôt qu'un email par magasin. Signale aussi, par nom, les
// magasins éligibles Kaizen (colonne `concept` renseignée) qui n'ont ouvert
// AUCUN audit ce mois-ci (pas juste "non clôturé" — littéralement aucune
// ligne kaizen_audits pour ce magasin/mois, même logique que
// getKaizenNotStartedByAR utilisée pour la relance hebdo).
async function cloturerAuditsKaizen(env, moisOverride) {
if (!env.DB) throw new Error('Base D1 non liée au Worker');
const mois = moisOverride || moisPrecedent();
const moisLbl = moisLabelKaizen(mois);
const stores = await getMagasinsServerSide();

const { results: audits } = await env.DB.prepare(
`SELECT * FROM kaizen_audits WHERE mois = ? AND closed = 0`
).bind(mois).all();

// Chargés une seule fois, avant la boucle, pour ne pas multiplier les
// requêtes/lectures par magasin (voir commentaire sur getKaizenItemsHistory).
const zones = await getKaizenReferentiel();
const { history, moisListe } = await getKaizenItemsHistory(env, mois);

const erreurs = [];
const clotures = []; // { code, libelle, animateur, score, scoreMax, cumulAnnuel }
const stuckKaizenItemsAll = []; // { libelle, animateur, itemLabel, zoneNom, moisConsecutifs }
for (const audit of audits) {
try {
const store = stores.find(s => s.code === audit.magasin_code);
const libelle = store ? store.libelle : audit.magasin_code;

await env.DB.prepare(
`UPDATE kaizen_audits SET closed = 1, closed_at = datetime('now') WHERE id = ?`
).bind(audit.id).run();

const { results: histo } = await env.DB.prepare(
`SELECT score FROM kaizen_audits WHERE magasin_code = ? AND mois LIKE ?`
).bind(audit.magasin_code, mois.slice(0, 4) + '-%').all();
const cumulAnnuel = Math.round(histo.reduce((s, r) => s + (r.score || 0), 0) * 10) / 10;

clotures.push({
code: audit.magasin_code,
libelle,
animateur: store ? store.animateur : null,
score: audit.score,
scoreMax: audit.score_max,
cumulAnnuel,
});

if (store) {
let itemsStateThisMonth = {};
try { itemsStateThisMonth = JSON.parse(audit.items_json || '{}'); } catch(e) {}
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const stuck = computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, history, moisListe, audit.magasin_code);
stuck.forEach(it => stuckKaizenItemsAll.push({
libelle, animateur: store.animateur, itemLabel: it.label, zoneNom: it.zoneNom, moisConsecutifs: it.moisConsecutifs,
}));
}
} catch (e) {
erreurs.push(`${audit.magasin_code}: ${String(e)}`);
}
}

// Magasins éligibles Kaizen sans aucune ligne kaizen_audits ce mois-ci (donc
// jamais commencés — à distinguer d'un audit commencé mais non clôturé, qui
// n'existe normalement plus à ce stade puisqu'on vient de tout clôturer).
const eligibleStores = stores.filter(s => s.concept && s.animateur);
const { results: auditesMois } = await env.DB.prepare(
`SELECT DISTINCT magasin_code FROM kaizen_audits WHERE mois = ?`
).bind(mois).all();
const startedCodes = new Set(auditesMois.map(r => r.magasin_code));
const nonFaits = eligibleStores.filter(s => !startedCodes.has(s.code));

const byAR = {};
clotures.forEach(c => { (byAR[c.animateur] ??= { clotures: [], nonFaits: [] }).clotures.push(c); });
nonFaits.forEach(s => { (byAR[s.animateur] ??= { clotures: [], nonFaits: [] }).nonFaits.push(s.libelle); });

function nonFaitsHtml(libelles, titre) {
if (!libelles.length) return '';
return `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">${escapeHtml(titre)}</h3><p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">${libelles.map(escapeHtml).join(', ')}</p>`;
}

for (const [ar, { clotures: arClotures, nonFaits: arNonFaits }] of Object.entries(byAR)) {
const arEmail = getArEmail(stores, ar);
if (!arEmail) continue;
try {
const table = arClotures.length ? htmlStatsTable(
['Magasin', 'Score du mois', 'Cumul annuel'],
arClotures.map(c => [c.libelle, `${c.score} / ${c.scoreMax}`, `${c.cumulAnnuel} / 400`])
) : `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun audit clôturé ce mois-ci.</p>`;
const arStuckItems = stuckKaizenItemsAll.filter(it => normalizeName(it.animateur) === normalizeName(ar));
const arStuckItemsHtml = htmlStuckKaizenItemsSection(arStuckItems, 'de votre périmètre');
await zimbraSendMail(env, {
to: arEmail,
subject: `Kaizen — clôture ${moisLbl} — ${ar}`,
bodyHtml: wrapEmailBody(table + nonFaitsHtml(arNonFaits, `Aucun audit Kaizen ce mois-ci (${arNonFaits.length})`) + arStuckItemsHtml),
});
} catch (e) {
erreurs.push(`Envoi récap Kaizen échoué pour ${ar}: ${String(e)}`);
}
}

try {
const tableReseau = clotures.length ? htmlStatsTable(
['Magasin', 'Animateur', 'Score du mois', 'Cumul annuel'],
clotures.map(c => [c.libelle, c.animateur || '—', `${c.score} / ${c.scoreMax}`, `${c.cumulAnnuel} / 400`])
) : `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun audit clôturé ce mois-ci.</p>`;
const nonFaitsLabels = nonFaits.map(s => `${s.libelle} (${s.animateur || '—'})`);
const stuckItemsHtmlReseau = htmlStuckKaizenItemsSection(stuckKaizenItemsAll, 'du réseau');
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `Kaizen — clôture ${moisLbl} — réseau`,
bodyHtml: wrapEmailBody(tableReseau + nonFaitsHtml(nonFaitsLabels, `Magasins sans aucun audit Kaizen ce mois-ci (${nonFaits.length})`) + stuckItemsHtmlReseau),
});
} catch (e) {
erreurs.push(`Envoi récap Kaizen réseau échoué: ${String(e)}`);
}

if (erreurs.length) {
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `Kaizen — anomalies clôture ${moisLbl}`,
bodyText: erreurs.join('\n'),
}).catch(() => {});
}
}

// --- Kaizen : agrégations pour /store-health, bilan mensuel, bilan hebdo/com hebdo ---
// (ajouté 13/08/2026, intégration Kaizen aux autres outils)

// Carte {magasin_code: {scoreMois, closedMois, cumulAnnuel, dernierScoreCloture,
// dernierScoreMax, dernierMoisCloture}} pour l'année en cours + dernier mois clôturé
// (toutes années confondues, pour rester robuste au changement d'année civile).
// Utilisée par /store-health, et par le score de santé composite (sous-score kaizen).
async function getKaizenHealthMap(env) {
if (!env.DB) return {};
try {
const moisCourant = new Date().toISOString().slice(0, 7);
const anneeCourante = moisCourant.slice(0, 4);
const { results } = await env.DB.prepare(
`SELECT magasin_code, mois, score, score_max, closed FROM kaizen_audits WHERE mois LIKE ?`
).bind(anneeCourante + '-%').all();
const map = {};
for (const row of results) {
const m = (map[row.magasin_code] ??= { scoreMois: null, scoreMaxMois: null, closedMois: false, cumulAnnuel: 0, dernierScoreCloture: null, dernierScoreMax: null, dernierMoisCloture: null });
m.cumulAnnuel += (row.score || 0);
if (row.mois === moisCourant) {
m.scoreMois = row.score;
m.scoreMaxMois = row.score_max;
m.closedMois = !!row.closed;
}
}
for (const m of Object.values(map)) {
m.cumulAnnuel = Math.round(m.cumulAnnuel * 10) / 10;
}

// Dernier mois clôturé, tous historiques confondus (pas limité à l'année en
// cours, pour rester correct en janvier vis-à-vis de décembre précédent).
const { results: closedRows } = await env.DB.prepare(
`SELECT magasin_code, mois, score, score_max FROM kaizen_audits WHERE closed = 1 ORDER BY mois DESC`
).all();
const seen = new Set();
for (const row of closedRows) {
if (seen.has(row.magasin_code)) continue; // déjà trouvé plus récent pour ce magasin (tri DESC)
seen.add(row.magasin_code);
const m = (map[row.magasin_code] ??= { scoreMois: null, scoreMaxMois: null, closedMois: false, cumulAnnuel: null, dernierScoreCloture: null, dernierScoreMax: null, dernierMoisCloture: null });
m.dernierScoreCloture = row.score;
m.dernierScoreMax = row.score_max;
m.dernierMoisCloture = row.mois;
}

return map;
} catch (e) {
console.error('Erreur calcul Kaizen (store-health):', e);
return {};
}
}

// Carte {animateur: [{libelle, score, scoreMax, closed, audited}]} pour un mois donné.
// Utilisée par le bilan mensuel — ne considère que les magasins éligibles Kaizen
// (colonne `concept` renseignée dans magasins.csv, cf. rollout auto-limité).
async function getKaizenMonthByAR(env, mois) {
if (!env.DB) return {};
try {
const stores = await getMagasinsServerSide();
const eligibleStores = stores.filter(s => s.concept);
if (!eligibleStores.length) return {};
const { results: audits } = await env.DB.prepare(
`SELECT magasin_code, score, score_max, closed FROM kaizen_audits WHERE mois = ?`
).bind(mois).all();
const auditByCode = {};
audits.forEach(a => { auditByCode[a.magasin_code] = a; });

const byAR = {};
for (const store of eligibleStores) {
if (!store.animateur) continue;
const a = auditByCode[store.code];
(byAR[store.animateur] ??= []).push({
libelle: store.libelle,
score: a ? a.score : null,
scoreMax: a ? a.score_max : null,
closed: !!(a && a.closed),
audited: !!a,
});
}
return byAR;
} catch (e) {
console.error('Erreur calcul Kaizen (bilan mensuel):', e);
return {};
}
}

// Carte {animateur: [libellés]} des magasins éligibles Kaizen dont l'audit du
// mois EN COURS n'a pas encore été commencé. Utilisée pour le simple rappel
// dans le bilan hebdo / com hebdo (pas de synthèse IA, juste une liste factuelle
// injectée dans le texte source — même traitement que les magasins sans données
// «Pour être dans le vert»).
async function getKaizenNotStartedByAR(env) {
if (!env.DB) return {};
try {
const stores = await getMagasinsServerSide();
const eligibleStores = stores.filter(s => s.concept);
if (!eligibleStores.length) return {};
const moisCourant = new Date().toISOString().slice(0, 7);
const { results: audits } = await env.DB.prepare(
`SELECT magasin_code FROM kaizen_audits WHERE mois = ?`
).bind(moisCourant).all();
const startedCodes = new Set(audits.map(a => a.magasin_code));
const byAR = {};
for (const store of eligibleStores) {
if (startedCodes.has(store.code)) continue;
if (!store.animateur) continue;
(byAR[store.animateur] ??= []).push(store.libelle);
}
return byAR;
} catch (e) {
console.error('Erreur calcul Kaizen (rappel hebdo):', e);
return {};
}
}

// --- Notes Google (rating + nb d'avis), cache D1 rafraîchi par cron ---
async function getGoogleRatingsCursor(env) {
const row = await env.DB.prepare('SELECT next_offset FROM google_ratings_cursor WHERE id = 1').first();
return row ? row.next_offset : 0;
}

async function setGoogleRatingsCursor(env, offset) {
await env.DB.prepare(
`INSERT INTO google_ratings_cursor (id, next_offset) VALUES (1, ?)
ON CONFLICT(id) DO UPDATE SET next_offset = excluded.next_offset`
).bind(offset).run();
}

async function refreshGoogleRatings(env) {
if (!env.DB) { console.error('Refresh Google ratings : base D1 non liée au Worker'); return; }
if (!env.GOOGLE_PLACES_API_KEY) { console.error('Refresh Google ratings : secret GOOGLE_PLACES_API_KEY manquant'); return; }

const stores = await getMagasinsServerSide();
const withPlaceId = stores.filter(s => s.googlePlaceId).sort((a, b) => String(a.code).localeCompare(String(b.code)));
if (withPlaceId.length === 0) { console.log('Refresh Google ratings : aucun magasin avec Place ID'); return; }

const offset = await getGoogleRatingsCursor(env);
const batch = [];
for (let i = 0; i < GOOGLE_RATINGS_BATCH_SIZE && i < withPlaceId.length; i++) {
batch.push(withPlaceId[(offset + i) % withPlaceId.length]);
}

let ok = 0, ko = 0;
for (const s of batch) {
try {
const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(s.googlePlaceId)}&fields=rating,user_ratings_total&key=${env.GOOGLE_PLACES_API_KEY}`;
const resp = await fetch(url);
const data = await resp.json();
if (data.status === 'OK' && data.result) {
await env.DB.prepare(
`INSERT INTO google_ratings (magasin_code, rating, reviews_count, updated_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(magasin_code) DO UPDATE SET rating = excluded.rating, reviews_count = excluded.reviews_count, updated_at = excluded.updated_at`
).bind(s.code, data.result.rating ?? null, data.result.user_ratings_total ?? null, new Date().toISOString()).run();
ok++;
} else {
console.error('Google Place Details échoué pour', s.code, s.libelle, '-', data.status);
ko++;
}
} catch (e) {
console.error('Erreur refresh rating pour', s.code, s.libelle, e);
ko++;
}
}

const newOffset = (offset + batch.length) % withPlaceId.length;
await setGoogleRatingsCursor(env, newOffset);

console.log(`Refresh Google ratings terminé : ${ok} OK, ${ko} échec(s) sur ${batch.length} magasins (lot ${offset}-${offset + batch.length - 1} sur ${withPlaceId.length})`);
}

function getArEmail(stores, arName) {
const target = normalizeName(arName);
const match = stores.find(s => normalizeName(s.animateur) === target && s.animateurEmail);
return match ? match.animateurEmail : null;
}

function normalizeName(s) {
return (s || '')
.normalize('NFD').replace(/[̀-ͯ]/g, '')
.toLowerCase()
.trim()
// Abréviations françaises courantes dans les noms de magasins ("St Gregoire"
// vs "Saint-Grégoire") — appliqué avant la normalisation finale pour que les
// deux s'écrivent de façon identique. \b = mot entier seulement, ne touche
// pas un "st"/"ste" qui serait une partie d'un autre mot.
.replace(/\bste\b/g, 'sainte')
.replace(/\bst\b/g, 'saint')
.replace(/[^a-z0-9]+/g, '.')
.replace(/^\.+|\.+$/g, '');
}

// Distance d'édition simple (insertion/suppression/substitution = coût 1),
// utilisée uniquement pour SUGGÉRER la correspondance magasins.csv la plus
// proche d'un nom "Pour être dans le vert" non reconnu — jamais pour décider
// automatiquement d'un rattachement (trop risqué), seulement pour aider
// Olivier à corriger plus vite.
function levenshteinDistance(a, b) {
const m = a.length, n = b.length;
if (m === 0) return n;
if (n === 0) return m;
let prev = Array.from({ length: n + 1 }, (_, j) => j);
for (let i = 1; i <= m; i++) {
const curr = [i];
for (let j = 1; j <= n; j++) {
const cost = a[i - 1] === b[j - 1] ? 0 : 1;
curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
}
prev = curr;
}
return prev[n];
}

// Pour un nom non reconnu, trouve le magasin de magasins.csv dont le libellé
// normalisé est le plus proche (distance d'édition la plus faible), avec un
// niveau de confiance indicatif. Renvoie null si aucun magasin n'est fourni.
function suggestClosestStore(unmatchedKey, stores) {
let best = null;
for (const s of stores) {
const key = normalizeName(s.libelle || '');
if (!key) continue;
const dist = levenshteinDistance(unmatchedKey, key);
if (!best || dist < best.dist) best = { store: s, dist };
}
if (!best) return null;
const longest = Math.max(unmatchedKey.length, normalizeName(best.store.libelle).length) || 1;
const ratio = best.dist / longest;
const confiance = ratio <= 0.15 ? 'forte' : ratio <= 0.35 ? 'moyenne' : 'faible';
return { libelle: best.store.libelle, code: best.store.code, distance: best.dist, confiance };
}

async function hmacSign(payloadStr) {
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode(AR_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadStr));
return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createArSession(ar) {
const payload = JSON.stringify({ ar, exp: Date.now() + AR_SESSION_TTL_MS });
const b64 = btoa(unescape(encodeURIComponent(payload)));
const sig = await hmacSign(b64);
return b64 + '.' + sig;
}

async function verifyArSession(token) {
if (!token || !token.includes('.')) return null;
const [b64, sig] = token.split('.');
const expectedSig = await hmacSign(b64);
if (sig !== expectedSig) return null;
let payload;
try { payload = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch(e) { return null; }
if (!payload || !payload.ar || !payload.exp || payload.exp < Date.now()) return null;
return payload.ar;
}

// Sessions Accompagnement Manager : même principe que hmacSign/createArSession/
// verifyArSession ci-dessus, mais avec sa propre clé (ACCOMP_SESSION_SECRET) et
// un payload {email, nom, exp} plutôt que {ar, exp} — domaine différent (itinérants,
// pas animateurs réseau), pas de raison de partager la clé de signature.
async function accompHmacSign(payloadStr) {
const enc = new TextEncoder();
const key = await crypto.subtle.importKey('raw', enc.encode(ACCOMP_SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadStr));
return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createAccompSession(email, nom) {
const payload = JSON.stringify({ email, nom, exp: Date.now() + ACCOMP_SESSION_TTL_MS });
const b64 = btoa(unescape(encodeURIComponent(payload)));
const sig = await accompHmacSign(b64);
return b64 + '.' + sig;
}

async function verifyAccompSession(token) {
if (!token || !token.includes('.')) return null;
const [b64, sig] = token.split('.');
const expectedSig = await accompHmacSign(b64);
if (sig !== expectedSig) return null;
let payload;
try { payload = JSON.parse(decodeURIComponent(escape(atob(b64)))); } catch(e) { return null; }
if (!payload || !payload.email || !payload.exp || payload.exp < Date.now()) return null;
return payload;
}

async function requireAccompSession(request, corsHeaders) {
const token = request.headers.get('X-Accomp-Session');
const session = await verifyAccompSession(token);
if (!session) return { session: null, error: jsonError('Session invalide ou expirée', 401, corsHeaders) };
return { session, error: null };
}

function jsonError(msg, status, corsHeaders) {
return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

function bilanMagasinLabel(b) {
return b.magasin?.libelle || b.magasin_libelle || '?';
}

function bilanMagasinCode(b) {
return b.magasin?.code || b.magasin_code || '?';
}

function avgOf(list, field) {
const vals = list.map(b => b[field]).filter(v => v !== undefined && v !== null && v !== '' && !isNaN(Number(v)));
return vals.length ? (vals.reduce((a, v) => a + Number(v), 0) / vals.length) : null;
}

// obsMagasinsByAR (optionnel, 26/08) : {ar: Set(codes magasin observés cette
// semaine)}, issu de obsMagasinsCodesByAR(). "Magasins visités" devient
// l'union bilans + observations (un magasin observé sans bilan compte comme
// visité) ; "Bilans" reste strictement le nombre de vrais bilans de passage,
// une observation n'est jamais comptée comme un bilan.
function computeArStats(byAR, obsMagasinsByAR) {
return Object.entries(byAR).map(([ar, list]) => {
const magasinsBilan = new Set(list.map(bilanMagasinCode));
const magasinsObs = (obsMagasinsByAR && obsMagasinsByAR[ar]) || new Set();
const magasinsTotal = new Set([...magasinsBilan, ...magasinsObs]);
return { label: ar, nbBilans: list.length, nbMagasins: magasinsTotal.size, avgHumeur: avgOf(list, 'humeur'), avgDuree: avgOf(list, 'duree') };
});
}

function computeFullStoreStats(arStores, bilansList, obsLastDateMap) {
const bilansByStore = {};
bilansList.forEach(b => {
const key = normalizeName(bilanMagasinLabel(b));
if (!bilansByStore[key]) bilansByStore[key] = [];
bilansByStore[key].push(b);
});
const obsMap = obsLastDateMap || {};
return arStores.map(s => {
const key = normalizeName(s.libelle);
const list = bilansByStore[key] || [];
const bilanLastDate = list.length ? list.map(b => b.date).sort().slice(-1)[0] : null;
// Dernière visite = la plus récente entre bilan et observation (26/08) —
// un magasin visité seulement via Observations Terrain cette semaine
// n'apparaissait plus "jamais visité" à tort dans le mail de l'AR.
const obsLastDate = obsMap[key] || null;
const lastDate = [bilanLastDate, obsLastDate].filter(Boolean).sort().slice(-1)[0] || null;
return {
label: s.libelle,
nbBilans: list.length,
lastDate,
avgHumeur: list.length ? avgOf(list, 'humeur') : null,
avgDuree: list.length ? avgOf(list, 'duree') : null,
};
});
}

function computeStoreStats(bilansList) {
const byMagasin = {};
bilansList.forEach(b => {
const key = bilanMagasinLabel(b);
if (!byMagasin[key]) byMagasin[key] = [];
byMagasin[key].push(b);
});
return Object.entries(byMagasin).map(([magasin, list]) => {
const lastDate = list.map(b => b.date).sort().slice(-1)[0];
return { label: magasin, nbBilans: list.length, lastDate, avgHumeur: avgOf(list, 'humeur'), avgDuree: avgOf(list, 'duree') };
});
}

function htmlStatsTable(headers, rows) {
const th = headers.map(h => `<th style="text-align:left;padding:8px 12px;background:#0D0D0D;color:#F0EDE6;font-family:Arial,Helvetica,sans-serif;font-size:12px">${encodeAstralAsHtmlEntities(escapeHtml(h))}</th>`).join('');
const trs = rows.map((r, i) => {
const bg = i % 2 === 0 ? '#F5F3EE' : '#FFFFFF';
const tds = r.map(c => {
const content = (c && typeof c === 'object' && 'raw' in c) ? c.raw : encodeAstralAsHtmlEntities(escapeHtml(String(c)));
return `<td style="padding:7px 12px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;border-bottom:1px solid #E5E2DA">${content}</td>`;
}).join('');
return `<tr style="background:${bg}">${tds}</tr>`;
}).join('');
return `<table style="width:100%;border-collapse:collapse;margin:6px 0 20px"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

function htmlBulletSections(sectionsMap) {
return Object.entries(sectionsMap).map(([title, bullets]) => {
const items = (Array.isArray(bullets) ? bullets : [bullets]).map(b => `<li style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;line-height:1.5;margin-bottom:4px">${encodeAstralAsHtmlEntities(escapeHtml(b))}</li>`).join('');
return `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">${encodeAstralAsHtmlEntities(escapeHtml(title))}</h3><ul style="margin:0 0 4px;padding-left:18px">${items}</ul>`;
}).join('');
}

function wrapEmailBody(innerHtml) {
return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:8px">${innerHtml}</div>`;
}

function resumeBilan(b, opts = {}) {
const { includeHumeur = true } = opts;
const actions = (b.actions || []).map(a => `- [${a.status || 'en cours'}] ${a.label || a.text || JSON.stringify(a)}`).join('\n') || 'Aucune action notée';
return [
`Date: ${b.date}${b.passage ? ' (passage n°' + b.passage + ')' : ''}`,
`Magasin: ${b.magasin?.libelle || b.magasin_libelle || '?'} (${b.magasin?.code || b.magasin_code || '?'})`,
`Animateur: ${b.ar || '?'}`,
(includeHumeur && b.humeur !== undefined && b.humeur !== null) ? `Humeur/ambiance (échelle 0 à 4 : 0=Difficile, 1=Mitigé, 2=Correct, 3=Bien, 4=Top !): ${b.humeur}/4` : '',
b.renta ? `Rentabilité salariale (ATTENTION : plus BAS = MEILLEUR, c'est un ratio coût salarial/CA, ne jamais présenter une valeur plus haute que l'objectif comme une réussite) : ${b.renta}%` : '',
b.ca_mensuel ? `CA mensuel: ${b.ca_mensuel}` : '',
b.forts ? `Points forts: ${b.forts}` : '',
b.diff ? `Difficultés: ${b.diff}` : '',
`Actions:\n${actions}`,
b.manager_obs ? `Observations manager: ${b.manager_obs}` : '',
b.remarque_libre ? `Remarque libre: ${b.remarque_libre}` : '',
].filter(Boolean).join('\n');
}

const OLIVIER_EMAIL = 'olivier.baroukh@optical-center.com';
// VANESSA_EMAIL supprimée le 21/08 : les observations terrain sont désormais
// intégrées au com hebdo automatique du dimanche (generateComHebdo /
// generateComHebdoForAR, voir plus bas) au lieu de partir par un bouton
// manuel dédié — generateObsComHebdo/formatObsEmail et les routes
// /obs-generate, /obs-send ont été retirés le même jour (devenus redondants).

async function purgeWeeklySources(env) {
try { await env.DB.prepare('DELETE FROM observations').run(); } catch(e) { console.error('Purge observations échouée:', e); }
try { await env.DB.prepare('DELETE FROM store_stats').run(); } catch(e) { console.error('Purge store_stats échouée:', e); }
}

function mostRecentWeekRange() {
const now = new Date();
const day = now.getUTCDay();
const diffToFriday = ((day - 5) + 7) % 7 || 7;
const friday = new Date(now); friday.setUTCDate(now.getUTCDate() - diffToFriday);
const monday = new Date(friday); monday.setUTCDate(friday.getUTCDate() - 4);
const fmt = d => d.toISOString().slice(0, 10);
return { from: fmt(monday), to: fmt(friday) };
}

async function getWeekData(env, override) {
const { from, to } = (override && override.from && override.to) ? override : mostRecentWeekRange();
const { results } = await env.DB.prepare(
'SELECT * FROM bilans WHERE date >= ? AND date <= ? ORDER BY ar, date'
).bind(from, to).all();
const bilans = results.map(r => { try { return JSON.parse(r.data_json); } catch(e) { return r; } });

const stores = await getMagasinsServerSide();
const allARs = [...new Set(stores.map(s => s.animateur).filter(Boolean))].sort();

const byAR = {};
allARs.forEach(a => byAR[a] = []);
bilans.forEach(b => {
const ar = b.ar || 'Non renseigné';
if (!byAR[ar]) byAR[ar] = [];
byAR[ar].push(b);
});

return { from, to, bilans, allARs, byAR };
}

// Résout STORE_STATS_NAME_ALIASES en une map {clé normalisée reçue -> clé
// normalisée du libellé magasins.csv réel}, pour les cas où le texte source
// est trop éloigné du libellé officiel pour un rapprochement automatique.
async function getStoreStatsAliasResolution(env) {
if (!STORE_STATS_NAME_ALIASES.length) return {};
const stores = await getMagasinsServerSide();
const resolution = {};
for (const a of STORE_STATS_NAME_ALIASES) {
const target = stores.find(s => s.code === a.code);
if (target) resolution[normalizeName(a.recu)] = normalizeName(target.libelle);
}
return resolution;
}

// Rattache une ligne store_stats à magasins.csv. Priorité au code magasin
// (colonne code_magasin, transmise par PEDLV depuis le 21/08 — extraite
// directement du fichier "Positionnement mensuel", jamais devinée) : rattachement
// exact, insensible aux fautes de frappe ou variantes du libellé. Si absent
// (anciens rapports envoyés avant le 21/08, ou libellé corrigé à la main dans
// PEDLV — qui n'envoie alors plus le code par précaution), repli sur
// normalizeName() + la table d'alias manuelle (comportement historique).
// Renvoie toujours une clé normalisée sur le libellé magasins.csv, pour que tous
// les points d'appel existants (storeStatsMap[normalizeName(store.libelle)])
// continuent de fonctionner sans changement.
function resolveStoreStatsKey(row, aliasResolution, storesByCode) {
if (row.code_magasin) {
const store = storesByCode.get(String(row.code_magasin).trim());
if (store) return normalizeName(store.libelle);
}
const rawKey = normalizeName(row.magasin);
return aliasResolution[rawKey] || rawKey;
}

async function getStoreStatsMap(env) {
if (!env.DB) return {};
let results;
try {
({ results } = await env.DB.prepare('SELECT * FROM store_stats ORDER BY id DESC').all());
} catch(e) { return {}; }
const aliasResolution = await getStoreStatsAliasResolution(env);
const stores = await getMagasinsServerSide();
const storesByCode = new Map(stores.map(s => [s.code, s]));
const map = {};
for (const r of results) {
const key = resolveStoreStatsKey(r, aliasResolution, storesByCode);
if (!map[key]) {
let prios = [];
try { prios = JSON.parse(r.prios_json || '[]'); } catch(e) {}
map[key] = { ...r, prios };
}
}
return map;
}

async function getStoreStatsCountMap(env) {
if (!env.DB) return {};
let results;
try {
({ results } = await env.DB.prepare('SELECT magasin, code_magasin FROM store_stats').all());
} catch(e) { return {}; }
const aliasResolution = await getStoreStatsAliasResolution(env);
const stores = await getMagasinsServerSide();
const storesByCode = new Map(stores.map(s => [s.code, s]));
const counts = {};
for (const r of results) {
const key = resolveStoreStatsKey(r, aliasResolution, storesByCode);
counts[key] = (counts[key] || 0) + 1;
}
return counts;
}

function currentWeekMonday(todayISO) {
const d = new Date((todayISO || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z');
const day = d.getUTCDay();
const diffToMonday = day === 0 ? 6 : day - 1;
d.setUTCDate(d.getUTCDate() - diffToMonday);
return d.toISOString().slice(0, 10);
}

function previousWeekMonday(todayISO) {
const d = new Date(currentWeekMonday(todayISO) + 'T00:00:00Z');
d.setUTCDate(d.getUTCDate() - 7);
return d.toISOString().slice(0, 10);
}

function summarizePedlvIndicateurs(indicateurs) {
const entries = Object.entries(indicateurs || {}).filter(([, v]) => v && v.statut);
if (!entries.length) return { rouge: null, total: null };
return { rouge: entries.filter(([, v]) => v.statut === 'rouge').length, total: entries.length };
}

async function getPreviousWeekPedlvMap(env) {
if (!env.DB) return {};
const period = previousWeekMonday();
let results;
try {
({ results } = await env.DB.prepare(
'SELECT magasin_key, pedlv_rouge, pedlv_total FROM store_stats_history WHERE period_key = ?'
).bind(period).all());
} catch(e) { return {}; }
const map = {};
for (const r of results) {
if (r.pedlv_total === null || r.pedlv_total === undefined) continue;
map[r.magasin_key] = { rouge: r.pedlv_rouge, total: r.pedlv_total };
}
return map;
}

// --- PEDLV : suivi des indicateurs rouges qui traînent d'une semaine à l'autre ---
// (ajouté 16/08/2026). indicateurs_json est déjà historisé par semaine dans
// store_stats_history (period_key = lundi de la semaine) — rien de nouveau à
// collecter. Le suivi se base sur `indicateurs` (statut structuré par clé),
// JAMAIS sur `prios` (texte libre régénéré à chaque import côté client, non
// historisé, pas fiable pour dire "c'est le même point qui traîne" — même
// principe que pour le rapprochement des noms de magasins).

async function getPedlvIndicateursHistory(env, periodCourant, lookbackWeeks = 6) {
if (!env.DB) return { history: {}, periodListe: [periodCourant] };
const periodListe = [periodCourant];
for (let i = 1; i < lookbackWeeks; i++) {
const d = new Date(periodListe[periodListe.length - 1] + 'T00:00:00Z');
d.setUTCDate(d.getUTCDate() - 7);
periodListe.push(d.toISOString().slice(0, 10));
}
const placeholders = periodListe.map(() => '?').join(',');
const { results } = await env.DB.prepare(
`SELECT magasin_key, period_key, indicateurs_json FROM store_stats_history WHERE period_key IN (${placeholders})`
).bind(...periodListe).all();
const history = {};
results.forEach(r => {
let indicateurs = {};
try { indicateurs = JSON.parse(r.indicateurs_json || '{}'); } catch(e) {}
(history[r.magasin_key] ??= {})[r.period_key] = indicateurs;
});
return { history, periodListe };
}

// Combien de semaines consécutives AVANT periodListe[0] (donc sans compter la
// semaine courante) cet indicateur était déjà rouge pour ce magasin. S'arrête
// à la première semaine sans historique, où l'indicateur est absent (grille
// PEDLV différente ce mois-là — on ne devine jamais), ou où il n'était pas rouge.
function computeIndicateurStreak(history, periodListe, magasinKey, indicateurKey) {
let streak = 0;
for (let i = 1; i < periodListe.length; i++) {
const indicateurs = history[magasinKey]?.[periodListe[i]];
if (!indicateurs || !(indicateurKey in indicateurs)) break;
if (indicateurs[indicateurKey]?.statut !== 'rouge') break;
streak++;
}
return streak;
}

function computeStuckPedlvIndicateurs(indicateursThisWeek, history, periodListe, magasinKey, threshold = 1) {
const out = [];
Object.entries(indicateursThisWeek || {}).forEach(([key, v]) => {
if (!v || v.statut !== 'rouge') return;
const streak = computeIndicateurStreak(history, periodListe, magasinKey, key);
if (streak >= threshold) {
out.push({ indicateur: (v && v.libelle) || key, semainesConsecutives: streak + 1 });
}
});
return out;
}

// Calcule la liste réseau des indicateurs PEDLV rouges qui traînent, pour tous
// les magasins ayant des données "Pour être dans le vert" actuelles.
async function computeStuckPedlvItemsForStores(env, stores, storeStatsMap) {
const periodCourant = currentWeekMonday();
const { history, periodListe } = await getPedlvIndicateursHistory(env, periodCourant);
const out = [];
stores.forEach(s => {
const stat = storeStatsMap[normalizeName(s.libelle || '')];
if (!stat) return;
let indicateursThisWeek = {};
try { indicateursThisWeek = JSON.parse(stat.indicateurs_json || '{}'); } catch(e) {}
const magasinKey = normalizeName(s.libelle || '');
const stuck = computeStuckPedlvIndicateurs(indicateursThisWeek, history, periodListe, magasinKey);
stuck.forEach(it => out.push({ libelle: s.libelle, animateur: s.animateur, indicateur: it.indicateur, semainesConsecutives: it.semainesConsecutives }));
});
return out;
}

function htmlStuckPedlvIndicateursSection(items, scopeLabel) {
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">🔁 Indicateurs PEDLV rouges depuis plusieurs semaines</h3>`;
if (!items.length) {
return title + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun indicateur rouge depuis plusieurs semaines ${scopeLabel}. ✅</p>`;
}
return title + htmlStatsTable(
['Magasin', 'Animateur', 'Indicateur', 'Depuis combien de semaines'],
items.map(i => [i.libelle, i.animateur, i.indicateur, i.semainesConsecutives])
);
}

const VISIT_REMINDER_THRESHOLD_DAYS = 28;

async function getLastVisitMap(env) {
if (!env.DB) return {};
const { results } = await env.DB.prepare(
'SELECT magasin_code, MAX(date) as last_date FROM bilans GROUP BY magasin_code'
).all();
const map = {};
for (const r of results) map[r.magasin_code] = r.last_date;
return map;
}

function daysBetween(isoFrom, isoTo) {
const a = new Date(isoFrom + 'T00:00:00Z');
const b = new Date(isoTo + 'T00:00:00Z');
return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function computeOverdueStores(stores, lastVisitMap, todayISO, lastObservationMap) {
const obsMap = lastObservationMap || {};
return stores
.filter(s => s.animateur)
.map(s => {
const bilanDate = lastVisitMap[s.code] || null;
const obsDate = obsMap[normalizeName(s.libelle)] || null;
const lastDate = [bilanDate, obsDate].filter(Boolean).sort().slice(-1)[0] || null;
const daysSince = lastDate ? daysBetween(lastDate, todayISO) : null;
return { code: s.code, libelle: s.libelle, animateur: s.animateur, lastDate, daysSince };
})
.filter(s => s.lastDate === null || s.daysSince >= VISIT_REMINDER_THRESHOLD_DAYS)
.sort((a, b) => (b.daysSince ?? 9999) - (a.daysSince ?? 9999));
}

function htmlOverdueSection(overdueStores, scopeLabel) {
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">Magasins en retard de visite (${VISIT_REMINDER_THRESHOLD_DAYS}j+)</h3>`;
if (!overdueStores.length) {
return title + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun — tous les magasins ${scopeLabel} ont été visités dans les ${VISIT_REMINDER_THRESHOLD_DAYS} derniers jours. ✅</p>`;
}
return title + htmlStatsTable(
['Magasin', 'Animateur', 'Dernière visite', 'Retard'],
overdueStores.map(s => [
s.libelle, s.animateur,
s.lastDate ? s.lastDate.split('-').reverse().join('/') : 'jamais',
s.lastDate ? `${s.daysSince}j` : '—',
])
);
}

// ── Digest hebdo : score de santé (dérive / accumulation de signaux) ──────
// Vient compléter (pas remplacer) la relance visite. Ne reprend jamais un
// magasin déjà signalé en retard de visite : ce signal reste prioritaire et
// géré par sa propre section. Duplique volontairement POIDS_SANTE /
// healthSubScores / computeHealthScore de index.html, car un cron ne peut
// pas exécuter le JS de l'app. ATTENTION : si les coefficients sont réglés
// via la modale ⚖️ de l'app et repoussés sur GitHub, il faut répercuter
// manuellement les mêmes valeurs ici, sinon le digest et l'onglet Tournée
// finiront par diverger.
const POIDS_SANTE_SERVER = {
actions: 7, effectif: 3, absenteisme: 4, positionnement: 5, pedlv: 8, avis: 4, equipe: 6, kaizen: 7,
entretiens: 6, lancements: 5,
};

function healthSubScoresServer(s) {
const scores = {};

if (s.actionsNonSoldees && Array.isArray(s.actionsNonSoldees.items)) {
const penalty = s.actionsNonSoldees.items
.filter(a => a.fromPrevious)
.reduce((acc, a) => acc + (a.status === 'todo' ? 25 : 15), 0);
scores.actions = Math.max(0, 100 - penalty);
} else {
scores.actions = null;
}

// Sous-effectif soutenu (RH, 3 mois consécutifs) combiné au sur-effectif
// déclaratif existant : on garde le pire des deux signaux. Le sur-effectif
// n'est pas affecté (le signal RH ne peut jamais faire remonter le score).
if (s.effectif && s.effectif.delta !== null && s.effectif.delta !== undefined) {
let score = s.effectif.delta <= 0 ? 100 : Math.max(0, 100 - s.effectif.delta * 25);
if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) {
score = Math.min(score, Math.max(0, 100 + s.effectifRH.ecartMoyen * 25));
}
scores.effectif = score;
} else if (s.effectifRH && s.effectifRH.soutenu && s.effectifRH.ecartMoyen !== null) {
scores.effectif = Math.max(0, 100 + s.effectifRH.ecartMoyen * 25);
} else {
scores.effectif = null;
}

// Absentéisme (RH, groupe A / jours ouvrés théoriques, longue durée incluse) —
// moyenne des notes mensuelles sur tous les mois disponibles pour ce magasin.
if (s.absenteisme && s.absenteisme.score !== null && s.absenteisme.score !== undefined) {
scores.absenteisme = s.absenteisme.score;
} else {
scores.absenteisme = null;
}

if (s.positionnementAnnuel !== null && s.positionnementAnnuel !== undefined) {
scores.positionnement = Math.max(0, Math.min(100, s.positionnementAnnuel));
} else {
scores.positionnement = null;
}

if (s.pedlv && s.pedlv.total) {
scores.pedlv = Math.max(0, 100 - (s.pedlv.rouge / s.pedlv.total) * 100);
} else {
scores.pedlv = null;
}

if (s.googleRating && s.googleRating.rating) {
scores.avis = Math.max(0, Math.min(100, (Number(s.googleRating.rating) / 5) * 100));
} else {
scores.avis = null;
}

if (s.niveauEquipe !== null && s.niveauEquipe !== undefined) {
scores.equipe = Math.max(0, Math.min(100, (Number(s.niveauEquipe) / 10) * 100));
} else {
scores.equipe = null;
}

// Kaizen : score du DERNIER mois clôturé (pas le mois en cours, qui peut être
// partiellement rempli et fausserait le score à la baisse en cours de mois).
// null tant qu'aucun mois n'a encore été clôturé pour ce magasin.
if (s.kaizenDernierScoreCloture !== null && s.kaizenDernierScoreCloture !== undefined && s.kaizenDernierScoreMax) {
scores.kaizen = Math.max(0, Math.min(100, (s.kaizenDernierScoreCloture / s.kaizenDernierScoreMax) * 100));
} else {
scores.kaizen = null;
}

// Entretiens individuels et lancements de journée (phase 3, 18/09) — JAMAIS
// null, contrairement à toutes les dimensions ci-dessus : 0 par défaut si
// s.entretiensLancements est absent (voir commentaire sur getEntretiensLancementsMap).
scores.entretiens = s.entretiensLancements ? s.entretiensLancements.tauxEntretiens : 0;
scores.lancements = s.entretiensLancements ? s.entretiensLancements.tauxLancements : 0;

return scores;
}

function computeHealthScoreServer(s, precomputedSub) {
const sub = precomputedSub || healthSubScoresServer(s);
let total = 0, possible = 0, totalWeight = 0;
Object.keys(POIDS_SANTE_SERVER).forEach(key => {
totalWeight += POIDS_SANTE_SERVER[key];
if (sub[key] === null) return;
total += sub[key] * POIDS_SANTE_SERVER[key];
possible += POIDS_SANTE_SERVER[key];
});
if (possible < totalWeight * 0.5) return null;
return Math.round(total / possible);
}

const HEALTH_LOW_SCORE_THRESHOLD = 60;
const HEALTH_DRIFT_THRESHOLD = 15;
const HEALTH_DRIFT_LOOKBACK_WEEKS = 4;

// Historique + écriture en requêtes groupées (une seule requête pour tous les
// magasins, pas une par magasin) pour rester loin de la limite de
// sous-requêtes du plan gratuit Workers — ce même cron (SAT) envoie déjà le
// rapport hebdomadaire et la relance visite dans la même invocation.
async function getHealthScoreHistoryMap(env, currentPeriodKey) {
if (!env.DB) return {};
try {
const cutoff = new Date(currentPeriodKey + 'T00:00:00Z');
cutoff.setUTCDate(cutoff.getUTCDate() - 7 * HEALTH_DRIFT_LOOKBACK_WEEKS);
const cutoffKey = cutoff.toISOString().slice(0, 10);
const { results } = await env.DB.prepare(
`SELECT magasin_code, period_key, score FROM store_health_score_history
WHERE period_key < ? AND period_key >= ? AND score IS NOT NULL
ORDER BY period_key ASC`
).bind(currentPeriodKey, cutoffKey).all();
const map = {};
for (const r of results) {
(map[r.magasin_code] ??= []).push({ period: r.period_key, score: r.score });
}
return map;
} catch(e) { console.error('Erreur lecture historique score santé:', e); return {}; }
}

async function saveHealthScoreHistoryBatch(env, rows) {
if (!env.DB || !rows.length) return;
try {
const stmt = env.DB.prepare(
`INSERT INTO store_health_score_history
(magasin_code, period_key, score, computed_at,
score_actions, score_effectif, score_absenteisme, score_positionnement, score_pedlv, score_avis, score_equipe, score_kaizen, score_entretiens, score_lancements)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(magasin_code, period_key) DO UPDATE SET
score = excluded.score, computed_at = excluded.computed_at,
score_actions = excluded.score_actions, score_effectif = excluded.score_effectif,
score_absenteisme = excluded.score_absenteisme, score_positionnement = excluded.score_positionnement,
score_pedlv = excluded.score_pedlv, score_avis = excluded.score_avis,
score_equipe = excluded.score_equipe, score_kaizen = excluded.score_kaizen,
score_entretiens = excluded.score_entretiens, score_lancements = excluded.score_lancements`
);
const now = new Date().toISOString();
await env.DB.batch(rows.map(r => {
const sub = r.sub || {};
return stmt.bind(
r.code, r.periodKey, r.score, now,
sub.actions ?? null, sub.effectif ?? null, sub.absenteisme ?? null, sub.positionnement ?? null,
sub.pedlv ?? null, sub.avis ?? null, sub.equipe ?? null, sub.kaizen ?? null,
sub.entretiens ?? null, sub.lancements ?? null
);
}));
} catch(e) { console.error('Erreur sauvegarde historique score santé (batch):', e); }
}

async function computeHealthDigest(env) {
const stores = await getMagasinsServerSide();
const withAr = stores.filter(s => s.animateur);
const results = await buildStoreHealthResults(env, withAr);
const periodKey = currentWeekMonday();
const historyMap = await getHealthScoreHistoryMap(env, periodKey);

const toSave = [];
const digest = [];
const noData = [];
for (const s of results) {
const score = s.score;
const sub = s.subScores;
toSave.push({ code: s.code, periodKey, score, sub });
if (s.overdue) continue; // déjà couvert par la relance visite
if (score === null) { noData.push({ code: s.code, libelle: s.libelle, animateur: s.animateur }); continue; } // pas assez de données pour calculer un score (moins de la moitié des critères renseignés)
const history = historyMap[s.code] || [];
const reasons = [];
if (score < HEALTH_LOW_SCORE_THRESHOLD) reasons.push('score faible');
if (history.length) {
const oldest = history[0];
if ((oldest.score - score) >= HEALTH_DRIFT_THRESHOLD) {
reasons.push(`en baisse (${oldest.score} → ${score})`);
}
}
if (reasons.length) digest.push({ code: s.code, libelle: s.libelle, animateur: s.animateur, score, reasons });
}
await saveHealthScoreHistoryBatch(env, toSave);
return { digest: digest.sort((a, b) => a.score - b.score), noData };
}

// noDataStores : magasins sans assez de données pour un score, désormais listés
// nommément (22/08, demande d'Olivier) plutôt que juste comptés — permet de les
// relancer directement sans deviner lesquels dans la liste du périmètre.
function htmlHealthDigestSection(digestStores, scopeLabel, noDataStores) {
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">Magasins à surveiller (score de santé)</h3>`;
const noDataCount = noDataStores.length;
const noDataNames = noDataStores.map(s => escapeHtml(s.libelle)).join(', ');
const noDataLine = noDataCount > 0
? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6b68;margin:0 0 10px;font-style:italic">ℹ️ ${noDataCount} magasin${noDataCount > 1 ? 's' : ''} ${scopeLabel} ${noDataCount > 1 ? "n'ont" : "n'a"} pas encore assez de données pour calculer un score de santé cette semaine (non compté${noDataCount > 1 ? 's' : ''} ci-dessous) : ${noDataNames}.</p>`
: '';
if (!digestStores.length) {
return title + noDataLine + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucun signal particulier ${scopeLabel} cette semaine. ✅</p>`;
}
return title + noDataLine + htmlStatsTable(
['Magasin', 'Animateur', 'Score', 'Motif'],
digestStores.map(s => [s.libelle, s.animateur, `${s.score}/100`, s.reasons.join(' · ')])
);
}

// Noms reçus via les imports "Pour être dans le vert" qui ne correspondent à
// aucun magasin de magasins.csv — donc jamais comptés nulle part par ailleurs
// (ni dans les tableaux par AR, ni dans le score de santé). Affiché uniquement
// à Olivier (pas d'AR à qui l'attribuer tant que le nom n'est pas reconnu).
function htmlUnmatchedNamesSection(unmatchedNames) {
if (!unmatchedNames.length) return '';
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">⚠️ Noms non reconnus (Pour être dans le vert)</h3>`;
const intro = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#6b6b68;margin:0 0 8px;font-style:italic">Ces noms sont arrivés dans un import mais ne correspondent à aucun magasin de magasins.csv — à vérifier (orthographe du libellé, magasin absent du référentiel...), sans quoi leurs données ne sont jamais rattachées à un animateur.</p>`;
const list = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">${unmatchedNames.map(n => encodeAstralAsHtmlEntities(escapeHtml(n))).join(', ')}</p>`;
return title + intro + list;
}

// Une action est considérée "qui traîne" à partir du moment où elle a déjà
// été reportée au moins une fois sans être soldée (_repriseCount >= 1, donc
// vue non résolue sur 2 visites ou plus). Le suivi lui-même (_fromPrevious,
// _repriseCount) est déjà géré côté client de Bilan de Passage à chaque
// visite — cette fonction ne fait que RENDRE VISIBLE côté réseau une donnée
// qui existe déjà mais n'était jusqu'ici lisible que magasin par magasin.
const ACTIONS_STUCK_REPRISE_THRESHOLD = 1;

function computeStuckActions(stores, snapshots, threshold = ACTIONS_STUCK_REPRISE_THRESHOLD) {
const out = [];
stores.forEach(s => {
const snap = snapshots[s.code];
if (!snap || !Array.isArray(snap.actions)) return;
snap.actions.forEach(a => {
const repriseCount = a._repriseCount || 0;
const fromPrevious = !!a._fromPrevious;
if (fromPrevious && repriseCount >= threshold) {
out.push({
libelle: s.libelle,
animateur: s.animateur,
text: a.text || a.label || '(action sans libellé)',
repriseCount,
});
}
});
});
return out;
}

function htmlStuckActionsSection(items, scopeLabel) {
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">🔁 Actions qui traînent (Bilan de Passage)</h3>`;
if (!items.length) {
return title + `<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 16px">Aucune action non soldée depuis plusieurs visites ${scopeLabel}. ✅</p>`;
}
return title + htmlStatsTable(
['Magasin', 'Animateur', 'Action', 'Depuis combien de visites'],
items.map(i => [i.libelle, i.animateur, i.text, i.repriseCount + 1])
);
}

// Suivi Managers → score de santé, phase 3 (18/09) — deux nouveaux signaux :
// couverture des entretiens individuels et cadence des lancements de journée.
// Contrairement à toutes les autres dimensions (exclues du score si pas de
// donnée), celles-ci valent 0 sans donnée — décision explicite d'Olivier :
// silence = magasin non piloté ce mois-ci, pas "pas encore mesuré". Cette
// règle reste propre à ces deux dimensions pour l'instant ; les autres
// basculeront sur le même principe en janvier 2027 (décision actée, pas
// encore appliquée).
// Limite connue : les jours d'ouverture magasin (dénominateur du taux de
// lancement) viennent du dernier mois RH connu pour ce site, faute de
// connaître déjà les fermetures/fériés du mois en cours — l'agenda RH n'est
// importé que le mois suivant. Utilisé comme meilleure estimation disponible.
async function getEntretiensLancementsMap(env) {
if (!env.DB) return {};
const moisActuel = new Date().toISOString().slice(0, 7);

let eligibleRows = [];
try {
({ results: eligibleRows } = await env.DB.prepare(
`SELECT es.code_site, es.matricule
FROM rh_effectif_site_mensuel es
JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
INNER JOIN (
SELECT code_site, MAX(mois) as maxmois FROM rh_effectif_site_mensuel WHERE site_reconnu = 1 GROUP BY code_site
) latest ON latest.code_site = es.code_site AND latest.maxmois = es.mois
WHERE es.site_reconnu = 1 AND (em.poste IS NULL OR em.poste != 'Manager')`
).all());
} catch (e) {}

const eligiblesParMagasin = {};
eligibleRows.forEach(r => {
(eligiblesParMagasin[r.code_site] = eligiblesParMagasin[r.code_site] || new Set()).add(r.matricule);
});

let entretienRows = [];
try {
({ results: entretienRows } = await env.DB.prepare(
`SELECT DISTINCT magasin_code, collaborateur_matricule
FROM entretiens_manager
WHERE date LIKE ? AND type IN ('pilotage_optique','pilotage_audio')
AND collaborateur_matricule IS NOT NULL`
).bind(moisActuel + '%').all());
} catch (e) {}
const vusParMagasin = {};
entretienRows.forEach(r => {
(vusParMagasin[r.magasin_code] = vusParMagasin[r.magasin_code] || new Set()).add(r.collaborateur_matricule);
});

// Jours d'ouverture du magasin (18/09) — source principale : le champ
// "jours ouvrés du mois" déjà saisi dans Pour être dans le vert (lun-ven du
// mois, modifiable), capté dans store_stats.jours_ouvres_mois à chaque
// génération de rapport. Repli sur l'estimation RH (dernier mois connu,
// jours_calendaires - fériés - fermetures) uniquement si PEDLV n'a encore
// rien remonté pour ce magasin.
const stores = await getMagasinsServerSide();
const storeStatsMap = await getStoreStatsMap(env);
const joursOuvertsPedlvParMagasin = {};
stores.forEach(store => {
const row = storeStatsMap[normalizeName(store.libelle)];
if (row && row.jours_ouvres_mois != null) joursOuvertsPedlvParMagasin[store.code] = Math.round(row.jours_ouvres_mois);
});

let joursRows = [];
try {
({ results: joursRows } = await env.DB.prepare(
`SELECT es.code_site, AVG(a.jours_calendaires) as cal, AVG(a.jours_feries) as feries, AVG(a.jours_fermeture_magasin) as fermeture
FROM rh_agenda_mensuel a
JOIN rh_effectif_site_mensuel es ON es.mois = a.mois AND es.matricule = a.matricule
INNER JOIN (
SELECT code_site, MAX(mois) as maxmois FROM rh_effectif_site_mensuel WHERE site_reconnu = 1 GROUP BY code_site
) latest ON latest.code_site = es.code_site AND latest.maxmois = es.mois
WHERE es.site_reconnu = 1
GROUP BY es.code_site`
).all());
} catch (e) {}
const joursOuvertsRhParMagasin = {};
joursRows.forEach(r => {
const j = Math.round((r.cal || 0) - (r.feries || 0) - (r.fermeture || 0));
joursOuvertsRhParMagasin[r.code_site] = j > 0 ? j : null;
});
const joursOuvertsParMagasin = { ...joursOuvertsRhParMagasin, ...joursOuvertsPedlvParMagasin };

let lancementRows = [];
try {
({ results: lancementRows } = await env.DB.prepare(
`SELECT magasin_code, COUNT(DISTINCT date) as jours FROM lancements_journee WHERE date LIKE ? GROUP BY magasin_code`
).bind(moisActuel + '%').all());
} catch (e) {}
const lancementsParMagasin = {};
lancementRows.forEach(r => { lancementsParMagasin[r.magasin_code] = r.jours; });

// 18/09 : décompte brut par type de trame (demandé pour la carte "Effectif"
// du dashboard — 4 lignes : pilotage, écoute & feedback, recadrage,
// lancements). N'a pas d'impact sur tauxEntretiens/tauxLancements ci-dessus
// (qui restent basés sur la couverture collaborateurs/jours).
let typeCountRows = [];
try {
({ results: typeCountRows } = await env.DB.prepare(
`SELECT magasin_code, type, COUNT(*) as n FROM entretiens_manager WHERE date LIKE ? GROUP BY magasin_code, type`
).bind(moisActuel + '%').all());
} catch (e) {}
const typeCountsParMagasin = {};
typeCountRows.forEach(r => {
(typeCountsParMagasin[r.magasin_code] = typeCountsParMagasin[r.magasin_code] || {})[r.type] = r.n;
});

const map = {};
const allCodes = new Set([
...Object.keys(eligiblesParMagasin), ...Object.keys(lancementsParMagasin), ...Object.keys(joursOuvertsParMagasin),
...Object.keys(typeCountsParMagasin),
]);
allCodes.forEach(code => {
const eligibles = eligiblesParMagasin[code] || new Set();
const vus = vusParMagasin[code] || new Set();
let nbVus = 0;
eligibles.forEach(m => { if (vus.has(m)) nbVus++; });
const tauxEntretiens = eligibles.size > 0 ? Math.round((nbVus / eligibles.size) * 100) : 0;

const joursOuverts = joursOuvertsParMagasin[code];
const joursLances = lancementsParMagasin[code] || 0;
const tauxLancements = joursOuverts ? Math.min(100, Math.round((joursLances / joursOuverts) * 100)) : 0;

const tc = typeCountsParMagasin[code] || {};
const nbPilotage = (tc.pilotage_optique || 0) + (tc.pilotage_audio || 0);
const nbEcouteFb = tc.ecoute_fb || 0;
const nbRecadrage = tc.recadrage || 0;

map[code] = {
tauxEntretiens, nbEligibles: eligibles.size, nbVus,
tauxLancements, joursOuverts: joursOuverts || 0, joursLances,
nbPilotage, nbEcouteFb, nbRecadrage, nbLancements: joursLances,
};
});
return map;
}

// Même logique que la route /store-health, factorisée pour être appelée aussi
// bien par la route (scope filtré par session AR) que par le cron du digest
// (scope = tous les magasins, sans notion de session).
async function buildStoreHealthResults(env, scope) {
const todayISO = new Date().toISOString().slice(0, 10);
const snapshots = await getLastBilanSnapshots(env);
const lastObservationMap = await getLastObservationMap(env);
let ratingsMap = {};
try {
const { results: ratingRows } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count FROM google_ratings').all();
ratingRows.forEach(r => { ratingsMap[r.magasin_code] = { rating: r.rating, reviewsCount: r.reviews_count }; });
} catch(e) {}

const storeStatsMap = await getStoreStatsMap(env);
const previousWeekPedlvMap = await getPreviousWeekPedlvMap(env);
const niveauxEquipeMap = await getNiveauxEquipeMap(env);
const kaizenHealthMap = await getKaizenHealthMap(env);
const rhHealthMap = await getRhHealthSignalsMap(env);
const entretiensLancementsMap = await getEntretiensLancementsMap(env);

return scope.map(store => {
const snap = snapshots[store.code] || null;
const bilanDate = snap ? snap.date : null;
const obsDate = lastObservationMap[normalizeName(store.libelle)] || null;
const lastVisitDate = [bilanDate, obsDate].filter(Boolean).sort().slice(-1)[0] || null;
const daysSinceVisit = lastVisitDate ? daysBetween(lastVisitDate, todayISO) : null;
const kz = kaizenHealthMap[store.code] || null;
const rhSignal = rhHealthMap[store.code] || null;
const result = {
code: store.code,
libelle: store.libelle,
animateur: store.animateur,
lastVisitDate,
daysSinceVisit,
lastBilanDate: bilanDate,
lastObservationDate: obsDate,
overdue: lastVisitDate === null || daysSinceVisit >= VISIT_REMINDER_THRESHOLD_DAYS,
effectif: computeEffectifStatus(snap, store.effTheo, rhSignal),
effectifRH: computeEffectifRH(rhSignal, store.effTheo),
absenteisme: { score: rhSignal ? rhSignal.absenteismeScore : null, moisCount: rhSignal ? rhSignal.moisCount : 0 },
positionnementAnnuel: snap ? snap.positionnementAnnuel : null,
googleRating: ratingsMap[store.code] || null,
actionsNonSoldees: snap ? {
count: (snap.actions || []).length,
items: (snap.actions || []).map(a => ({
text: a.text,
repriseCount: a._repriseCount || 0,
fromPrevious: !!a._fromPrevious,
status: a._status || null,
})),
} : null,
pedlv: computePedlvSummary(storeStatsMap[normalizeName(store.libelle)]),
pedlvTrend: previousWeekPedlvMap[normalizeName(store.libelle)] || null,
niveauEquipe: niveauxEquipeMap[store.code] ?? null,
objectifNiveauEquipe: OBJECTIF_NIVEAU_EQUIPE,
kaizenScoreMois: kz ? kz.scoreMois : null,
kaizenScoreMaxMois: kz ? kz.scoreMaxMois : null,
kaizenClosedMois: kz ? kz.closedMois : false,
kaizenCumulAnnuel: kz ? kz.cumulAnnuel : null,
kaizenDernierScoreCloture: kz ? kz.dernierScoreCloture : null,
kaizenDernierScoreMax: kz ? kz.dernierScoreMax : null,
kaizenDernierMoisCloture: kz ? kz.dernierMoisCloture : null,
entretiensLancements: entretiensLancementsMap[store.code] || { tauxEntretiens: 0, tauxLancements: 0, nbEligibles: 0, nbVus: 0, joursOuverts: 0, joursLances: 0, nbPilotage: 0, nbEcouteFb: 0, nbRecadrage: 0, nbLancements: 0 },
};
// Score global + détail des 8 sous-scores — mêmes fonctions que le digest
// hebdo et l'historisation (aucune nouvelle logique de calcul). Ajouté ici
// pour que dashboard.html n'ait pas à dupliquer POIDS_SANTE une 3e fois
// (déjà dupliqué worker.js / bilan-passage/index.html).
result.subScores = healthSubScoresServer(result);
result.score = computeHealthScoreServer(result, result.subScores);
return result;
}).sort((a, b) => (b.daysSinceVisit ?? 9999) - (a.daysSinceVisit ?? 9999));
}

function lastVisitCell(lastDateAllTime, todayISO) {
if (!lastDateAllTime) {
return { raw: `<span style="color:#CC1719;font-weight:bold">jamais</span>` };
}
const daysSince = daysBetween(lastDateAllTime, todayISO);
const label = escapeHtml(lastDateAllTime.split('-').reverse().join('/'));
if (daysSince >= VISIT_REMINDER_THRESHOLD_DAYS) {
return { raw: `<span style="color:#CC1719;font-weight:bold">${label}</span>` };
}
return label;
}

function overdueCountCell(count) {
if (!count) return '0';
return { raw: `<span style="color:#CC1719;font-weight:bold">${count}</span>` };
}

function toNumOrNull(v) {
if (v === undefined || v === null || v === '') return null;
const n = parseFloat(v);
return Number.isFinite(n) ? n : null;
}

async function getLastBilanSnapshots(env) {
if (!env.DB) return {};
const { results } = await env.DB.prepare(`
SELECT magasin_code, date, ca_annuel, data_json FROM (
SELECT magasin_code, date, ca_annuel, data_json,
ROW_NUMBER() OVER (PARTITION BY magasin_code ORDER BY date DESC, id DESC) as rn
FROM bilans
) WHERE rn = 1
`).all();
const map = {};
for (const row of results) {
let data = {};
try { data = JSON.parse(row.data_json); } catch(e) {}
const mag = data.magasin || {};
map[row.magasin_code] = {
date: row.date,
positionnementAnnuel: toNumOrNull(row.ca_annuel),
effOpt: toNumOrNull(mag.eff_opt),
effAudio: toNumOrNull(mag.eff_audio),
effTheo: toNumOrNull(mag.eff_theo),
actions: Array.isArray(data.actions) ? data.actions : [],
};
}
return map;
}

const OBSERVATION_MAGASIN_ALIASES = {
'vitry': 'Vitry-sur-Seine',
'quincy': 'Quincy-sous-Sénart',
};

async function getLastObservationMap(env) {
if (!env.DB) return {};
let results;
try {
({ results } = await env.DB.prepare('SELECT magasin, last_date FROM observation_last_visit').all());
} catch(e) { return {}; }
const map = {};
for (const row of results) {
const key = normalizeName(row.magasin);
const resolved = OBSERVATION_MAGASIN_ALIASES[key] || row.magasin;
map[normalizeName(resolved)] = row.last_date;
}
return map;
}

// effTheo est lu en direct depuis magasins.csv (voir getMagasinsServerSide,
// 19/08) — il n'est de toute façon jamais saisi par l'AR. effOpt/effAudio
// (effectif réel confirmé/corrigé en visite) restent tirés du dernier bilan
// quand il existe. Repli RH (19/08, suite au cas Lille) : un magasin sans
// bilan exploitable mais avec des données RH (import mensuel) utilise
// l'effectif réel RH du dernier mois connu plutôt que de rester sans score —
// même formule, donc toujours neutre sur un sous-effectif isolé (la pénalité
// "soutenu" reste gérée séparément par computeEffectifRH).
function computeEffectifStatus(snapshot, effTheo, rhSignal) {
if (effTheo === null || effTheo === undefined) return { label: 'pas de données', delta: null };
if (snapshot && snapshot.effOpt !== null && snapshot.effAudio !== null) {
const delta = Math.round((snapshot.effOpt + snapshot.effAudio - effTheo) * 10) / 10;
const label = delta === 0 ? 'OK' : (delta > 0 ? `+${delta}` : `${delta}`);
return { label, delta };
}
if (rhSignal && rhSignal.dernierMois) {
const delta = Math.round((rhSignal.dernierMois.effectifDispo - effTheo) * 10) / 10;
const label = delta === 0 ? 'OK' : (delta > 0 ? `+${delta}` : `${delta}`);
return { label, delta };
}
return { label: 'pas de données', delta: null };
}

function computePedlvSummary(row) {
if (!row) return null;
let indicateurs = {};
try { indicateurs = JSON.parse(row.indicateurs_json || '{}'); } catch(e) {}
const entries = Object.entries(indicateurs).filter(([, v]) => v && v.statut);
if (!entries.length) return null;
const rouge = entries.filter(([, v]) => v.statut === 'rouge').length;
return { rouge, total: entries.length, indicateurs, periode: row.periode || null };
}

function buildArStoreCoverage(stores, storeStatsMap) {
const byAR = {};
stores.forEach(s => {
if (!s.animateur) return;
if (!byAR[s.animateur]) byAR[s.animateur] = { withData: [], withoutData: [] };
const stat = storeStatsMap[normalizeName(s.libelle || '')];
if (stat) byAR[s.animateur].withData.push({ libelle: s.libelle, stat });
else byAR[s.animateur].withoutData.push(s.libelle);
});
return byAR;
}

// storeStatsMap est indexé par nom normalisé (venant du texte libre "magasin"
// des imports "Pour être dans le vert"). buildArStoreCoverage() ne regarde que
// le sens "un magasin connu a-t-il des données ?" — cette fonction regarde le
// sens inverse : des données sont arrivées sous un nom qui ne correspond à
// AUCUN magasin de magasins.csv (donc jamais rattachées à un AR, silencieusement
// invisibles ailleurs). Sert à distinguer "pas encore de données cette semaine"
// (normal) de "les données arrivent mais sous un nom non reconnu" (à corriger).
function findUnmatchedStoreStatsNames(stores, storeStatsMap) {
const knownKeys = new Set(stores.map(s => normalizeName(s.libelle || '')));
const unmatched = [];
for (const [key, stat] of Object.entries(storeStatsMap)) {
if (!knownKeys.has(key)) unmatched.push(stat.magasin || key);
}
return unmatched;
}

function storeStatsSummaryText(entry) {
const s = entry.stat;
const parts = [
s.ca_total !== null ? `CA: ${Number(s.ca_total).toFixed(1)}k€` : '',
s.objectif !== null ? `objectif: ${Number(s.objectif).toFixed(1)}k€` : '',
s.raf !== null ? `RAF: ${Number(s.raf).toFixed(1)}k€` : '',
s.panier_moyen !== null ? `panier moyen: ${Number(s.panier_moyen).toFixed(0)}€` : '',
].filter(Boolean).join(', ');
const topPrios = (entry.stat.prios || []).slice(0, 2).map(p => p.titre).filter(Boolean);
return `${entry.libelle} — ${parts}` + (topPrios.length ? ` | Points de vigilance : ${topPrios.join(' ; ')}` : '');
}

function escapeHtml(s) {
return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Suivi Managers (17/09) — une date affichée dans un mail (sujet ou corps)
// doit être en jj/mm/aaaa, jamais l'ISO aaaa-mm-jj envoyé par le client. Le
// data_json stocké en base reste en ISO (non touché ici), seul l'affichage change.
function formatDateFr(iso) {
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '');
}

function encodeAstralAsHtmlEntities(s) {
return (s || '').replace(/[\u{10000}-\u{10FFFF}]/gu, ch => `&#${ch.codePointAt(0)};`);
}

function textToHtmlEmail(bodyText) {
const lines = (bodyText || '').split('\n');
let html = '';
let inParagraph = false;
const closeP = () => { if (inParagraph) { html += '</p>'; inParagraph = false; } };
for (const rawLine of lines) {
const line = rawLine.trim();
const sectionMatch = line.match(/^---\s*(.+?)\s*---$/);
if (sectionMatch) {
closeP();
html += `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:15px;margin:22px 0 8px;border-bottom:2px solid #CC1719;padding-bottom:4px">${encodeAstralAsHtmlEntities(escapeHtml(sectionMatch[1]))}</h3>`;
} else if (line === '') {
closeP();
} else {
if (!inParagraph) { html += '<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#2C2C2A;margin:0 0 10px">'; inParagraph = true; }
else html += '<br>';
html += encodeAstralAsHtmlEntities(escapeHtml(line));
}
}
closeP();
return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:8px">${html}</div>`;
}

// Suivi Managers (16/09, simplifié le 17/09) — le contenu complet vit
// désormais dans le PDF joint (même identité visuelle que les autres
// outils, généré côté client) ; le corps du mail reste court. Si jamais
// aucun PDF n'a pu être généré côté client (hasPdf=false), on retombe sur
// l'ancien dump JSON + images de signature en repli, pour ne jamais perdre
// le contenu même si le PDF échoue.
function buildEntretienManagerEmailHtml({ libelleType, magasin, remplipar, date, data, collaborateurNom, hasPdf }) {
const collabLine = collaborateurNom ? `<p><b>Collaborateur :</b> ${escapeHtml(collaborateurNom)}</p>` : '';
if (hasPdf) {
return `<div style="font-family:Arial,sans-serif;">
<h2 style="color:#CC1719;">${escapeHtml(libelleType)}</h2>
<p><b>Magasin :</b> ${escapeHtml(magasin.libelle)}</p>
${collabLine}
<p><b>Réalisé par :</b> ${escapeHtml(remplipar)} — <b>Date :</b> ${escapeHtml(formatDateFr(date))}</p>
<p>Le compte-rendu complet est joint à ce mail au format PDF.</p>
</div>`;
}
const { signatureManager, signatureCollaborateur, ...dataSansSignatures } = data || {};
const sigImg = (label, dataUrl) => dataUrl
  ? `<div style="margin-top:10px;"><b>${label} :</b><br><img src="${dataUrl}" style="max-width:220px;max-height:90px;border:1px solid #ddd;border-radius:4px;padding:4px;background:#fff;"></div>`
  : `<div style="margin-top:10px;color:#888;"><b>${label} :</b> non signé</div>`;
return `<div style="font-family:Arial,sans-serif;">
<h2 style="color:#CC1719;">${escapeHtml(libelleType)}</h2>
<p><b>Magasin :</b> ${escapeHtml(magasin.libelle)}</p>
${collabLine}
<p><b>Réalisé par :</b> ${escapeHtml(remplipar)} — <b>Date :</b> ${escapeHtml(formatDateFr(date))}</p>
<p style="color:#888;font-size:12px;">(PDF non généré pour cet envoi — contenu brut ci-dessous)</p>
<pre style="background:#F0EDE6;padding:12px;white-space:pre-wrap;">${escapeHtml(JSON.stringify(dataSansSignatures, null, 2))}</pre>
${sigImg('Signature du manager', signatureManager)}
${sigImg('Signature du collaborateur', signatureCollaborateur)}
</div>`;
}

async function zimbraSendMail(env, { to, subject, bodyText, bodyHtml }) {
const authResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
Body: {
AuthRequest: {
_jsns: 'urn:zimbraAccount',
account: { by: 'name', _content: env.ZIMBRA_CRON_USER },
password: { _content: env.ZIMBRA_CRON_PASS }
}
}
})
});
const authData = await authResp.json();
const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
if (!token) throw new Error('Authentification Zimbra (compte cron) échouée');

const sendResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' }, authToken: [{ _content: token }] } },
Body: {
SendMsgRequest: {
_jsns: 'urn:zimbraMail',
m: { su: { _content: subject }, e: [{ t: 't', a: to }], mp: { ct: 'text/html', content: { _content: bodyHtml || textToHtmlEmail(bodyText) } } }
}
}
})
});
if (!sendResp.ok) throw new Error('Envoi email échoué (' + sendResp.status + ')');
}

// Suivi Managers (17/09) — variante avec pièce jointe PDF, même compte
// d'automatisation que zimbraSendMail (jamais de mot de passe demandé au
// manager qui remplit la trame). Reprend le flux déjà validé côté client
// pour Bilan de Passage / Accompagnement Manager (auth -> upload -> envoi
// avec attach.aid), simplement exécuté ici côté Worker avec le compte cron.
// pdfBase64 est une chaîne base64 brute (pas de préfixe data:...;base64,).
async function zimbraSendMailWithAttachment(env, { to, subject, bodyHtml, pdfBase64, filename }) {
const authResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
Body: {
AuthRequest: {
_jsns: 'urn:zimbraAccount',
account: { by: 'name', _content: env.ZIMBRA_CRON_USER },
password: { _content: env.ZIMBRA_CRON_PASS }
}
}
})
});
const authData = await authResp.json();
const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
if (!token) throw new Error('Authentification Zimbra (compte cron) échouée');

const bin = atob(pdfBase64);
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const pdfBlob = new Blob([bytes], { type: 'application/pdf' });
const formData = new FormData();
formData.append('file', pdfBlob, filename || 'document.pdf');
const upResp = await fetch(ZIMBRA_UPLOAD_URL, {
method: 'POST',
headers: { 'Cookie': `ZM_AUTH_TOKEN=${token}` },
body: formData,
});
const upText = await upResp.text();
const upMatch = upText.match(/^\s*(\d+)\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
if (!upMatch || upMatch[1] !== '200') throw new Error('Échec upload pièce jointe : ' + upText.slice(0, 200));
const attachId = upMatch[3];

const sendResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' }, authToken: [{ _content: token }] } },
Body: {
SendMsgRequest: {
_jsns: 'urn:zimbraMail',
m: { su: { _content: subject }, e: [{ t: 't', a: to }], mp: { ct: 'text/html', content: { _content: bodyHtml } }, attach: { aid: attachId } }
}
}
})
});
if (!sendResp.ok) throw new Error('Envoi email échoué (' + sendResp.status + ')');
}

async function generateWeeklyReport(env, override) {
const { from, to, bilans, byAR } = await getWeekData(env, override);
const stores = await getMagasinsServerSide();
const storeStatsMap = await getStoreStatsMap(env);
const coverage = buildArStoreCoverage(stores, storeStatsMap);
const unmatchedNames = findUnmatchedStoreStatsNames(stores, storeStatsMap);
const hasStoreStats = Object.keys(storeStatsMap).length > 0;
const kaizenNotStartedByAR = await getKaizenNotStartedByAR(env);
// Observations Terrain (26/08) : intégrées à la synthèse IA de l'AR au même
// titre que les bilans/PEDLV/Kaizen, comme déjà fait pour le com hebdo du
// dimanche (generateComHebdoForAR) — sinon un AR sans bilan cette semaine
// mais actif sur Observations Terrain ressortait à tort avec une synthèse vide.
const { byAR: obsByAR } = await getObservationsGroupedByAR(env, stores);

const sections = Object.entries(byAR).map(([ar, list]) => {
const parts = [];
parts.push(list.length
? `=== ${ar} (${list.length} bilan(s) de passage) ===\n` + list.map(resumeBilan).join('\n\n---\n\n')
: `=== ${ar} ===\nAucun bilan de passage enregistré cette semaine.`);
const cov = coverage[ar];
if (cov) {
if (cov.withData.length) {
parts.push(`Données «Pour être dans le vert» pour ${ar} :\n` + cov.withData.map(storeStatsSummaryText).join('\n'));
}
if (cov.withoutData.length) {
parts.push(`Magasins de ${ar} sans données «Pour être dans le vert» cette semaine : ${cov.withoutData.join(', ')}.`);
}
}
const kzNotStarted = kaizenNotStartedByAR[ar] || [];
if (kzNotStarted.length) {
parts.push(`Kaizen : audit du mois pas encore commencé pour ${kzNotStarted.join(', ')}.`);
}
const arObs = obsByAR[ar] || [];
if (arObs.length) {
parts.push(`Observations terrain de la semaine pour ${ar} :\n` + arObs.map(formatObservationLine).join('\n'));
}
return parts.join('\n\n');
}).join('\n\n\n');

const systemPrompt = `Tu prépares le bilan hebdomadaire du réseau Optical Center. Pour CHAQUE animateur listé (même ceux sans bilan cette semaine), produis 2 à 4 puces COURTES (une phrase chacune maximum) en te basant sur TOUTES les données disponibles pour lui : bilans de passage (sujets abordés, résultats), données «Pour être dans le vert» si présentes (CA, objectif, RAF, points de vigilance), observations terrain si présentes (constats notés au fil de l'eau, sans lien avec une visite formelle), et rappel Kaizen si présent (audit du mois pas encore commencé pour certains magasins — reste factuel et neutre, ne pas en faire une puce alarmiste). Si des magasins de cet animateur n'ont pas de données «Pour être dans le vert» cette semaine, ajoute UNE puce factuelle et neutre le mentionnant (pas de jugement, juste l'information). Si un animateur n'a ni bilan, ni données, ni observation, une seule puce suffit. Reste factuel, base-toi uniquement sur les données fournies. Le tableau chiffré est déjà généré séparément, ne répète pas les chiffres bruts de comptage (nombre de bilans/magasins/observations) dans tes puces — concentre-toi sur le contenu qualitatif et les résultats. ATTENTION sur la rentabilité salariale (renta) : c'est un ratio coût salarial/CA où plus BAS est MEILLEUR — ne jamais qualifier une valeur supérieure à l'objectif de positive, c'est l'inverse d'un CA ou d'un taux de vente classique.

Réponds uniquement en JSON valide, sans texte avant/après, sans balises markdown, sous la forme :
IMPORTANT JSON : n'utilise JAMAIS le caractère guillemet droit (") à l'intérieur des valeurs de texte (ça casse le JSON) — utilise des guillemets français « » ou pas de guillemets du tout, y compris pour citer "Pour être dans le vert" ou tout autre nom entre guillemets.
{ "Nom Animateur 1": ["puce 1", "puce 2"], "Nom Animateur 2": ["puce 1", "puce 2"], ... }
Utilise exactement les noms d'animateurs tels que donnés en entrée, comme clés.`;

let byArBullets = {};
const hasObservations = Object.values(obsByAR).some(list => list.length);
const debugInfo = { from, to, totalBilans: bilans.length, hasStoreStats, hasObservations, byAR: Object.fromEntries(Object.entries(byAR).map(([k,v]) => [k, v.length])) };

if ((bilans.length || hasStoreStats || hasObservations) && env.ANTHROPIC_API_KEY) {
const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, thinking: { type: 'disabled' }, system: systemPrompt, messages: [{ role: 'user', content: sections }] }),
});
const claudeData = await claudeResp.json();
if (claudeResp.ok) {
const rawText = (claudeData.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
try { byArBullets = extractJson(rawText); }
catch(e) { byArBullets = { 'Erreur': ['Réponse IA non-JSON : ' + e.message + ' | debug: ' + JSON.stringify({stop_reason: claudeData.stop_reason, contentBlockTypes: (claudeData.content || []).map(c => c.type), model: claudeData.model, usage: claudeData.usage}).slice(0, 500)] }; }
} else {
byArBullets = { 'Erreur': ['Erreur génération synthèse IA : ' + JSON.stringify(claudeData)] };
}
}

const subject = `Bilan hebdomadaire réseau — semaine du ${from.split('-').reverse().join('/')} au ${to.split('-').reverse().join('/')}`;
return { subject, from, to, byAR, byArBullets, coverage, unmatchedNames, debugInfo };
}

function formatHumeur(v) { return v === null || v === undefined ? '—' : v.toFixed(1); }

function formatDuree(v) {
if (v === null || v === undefined) return '—';
const totalMin = Math.round(v * 60);
const h = Math.floor(totalMin / 60);
const m = totalMin % 60;
return `${h}h${String(m).padStart(2, '0')}`;
}

async function saveWeeklyReport(env, reportType, scope, weekFrom, weekTo, content) {
if (!env.DB) return;
try {
await env.DB.prepare(
`INSERT INTO weekly_reports (report_type, scope, week_from, week_to, content) VALUES (?, ?, ?, ?, ?)`
).bind(reportType, scope, weekFrom, weekTo, content).run();
} catch(e) { console.error('Erreur sauvegarde weekly_reports:', e); }
}

function bulletsToText(sectionsMap) {
return Object.entries(sectionsMap).map(([title, bullets]) =>
title + ' :\n' + (Array.isArray(bullets) ? bullets : [bullets]).map(b => '- ' + b).join('\n')
).join('\n\n');
}

const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function moisLabel(isoDate) {
const d = new Date(isoDate + 'T00:00:00Z');
return MOIS_FR[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

function mostRecentMonthRange() {
const now = new Date();
const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 24 * 60 * 60 * 1000);
const firstOfPrevMonth = new Date(Date.UTC(lastOfPrevMonth.getUTCFullYear(), lastOfPrevMonth.getUTCMonth(), 1));
const fmt = d => d.toISOString().slice(0, 10);
return { from: fmt(firstOfPrevMonth), to: fmt(lastOfPrevMonth) };
}

async function getWeeklyReportsForRange(env, from, to) {
if (!env.DB) return [];
try {
const { results } = await env.DB.prepare(
'SELECT * FROM weekly_reports WHERE week_from >= ? AND week_from <= ? ORDER BY scope, week_from'
).bind(from, to).all();
return results;
} catch(e) { return []; }
}

async function generateMonthlyReport(env, override) {
const { from, to } = override || mostRecentMonthRange();
const { byAR } = await getWeekData(env, { from, to });
const weeklyRows = await getWeeklyReportsForRange(env, from, to);
const arStats = computeArStats(byAR);
const mois = from.slice(0, 7);
const kaizenByAR = await getKaizenMonthByAR(env, mois);

const bilanHebdoByScope = {};
const comHebdoByScope = {};
weeklyRows.forEach(r => {
const target = r.report_type === 'bilan_hebdo' ? bilanHebdoByScope : comHebdoByScope;
if (!target[r.scope]) target[r.scope] = [];
target[r.scope].push(`Semaine du ${r.week_from} :\n${r.content}`);
});

const allARs = Array.from(new Set([...Object.keys(byAR), ...Object.keys(kaizenByAR)]));
const sections = allARs.map(ar => {
const parts = [`=== ${ar} ===`];
const bh = bilanHebdoByScope[ar] || [];
const ch = comHebdoByScope[ar] || [];
if (bh.length) parts.push(`Synthèses hebdo du mois (bilans) :\n` + bh.join('\n\n'));
if (ch.length) parts.push(`Com hebdo du mois :\n` + ch.join('\n\n'));
if (!bh.length && !ch.length) parts.push('(Aucune synthèse hebdomadaire enregistrée ce mois-ci pour cet animateur.)');
const kz = kaizenByAR[ar] || [];
if (kz.length) {
const kzText = kz.map(s => s.audited
? `${s.libelle} : ${s.score}/${s.scoreMax}${s.closed ? '' : ' (en cours, pas encore clôturé)'}`
: `${s.libelle} : audit Kaizen non réalisé ce mois-ci`
).join('\n');
parts.push(`Kaizen du mois (audit 5S, /${kz[0]?.scoreMax ?? 50} points) :\n${kzText}`);
}
return parts.join('\n\n');
}).join('\n\n\n');

const systemPrompt = `Tu prépares le bilan MENSUEL du réseau Optical Center, à partir des synthèses hebdomadaires déjà rédigées durant le mois pour chaque animateur, et des résultats Kaizen (audit mensuel 5S par magasin) du mois. Pour CHAQUE animateur listé, produis 3 à 5 puces courtes qui dégagent les tendances du mois : évolution semaine après semaine, sujets récurrents, points d'amélioration, réussites. Intègre les résultats Kaizen quand ils sont fournis — ce sont des données nouvelles (pas déjà affichées dans le tableau chiffré), mentionne les scores notables et signale explicitement tout magasin n'ayant pas encore été audité ce mois-ci, sans dramatiser. Le tableau chiffré du mois (bilans de passage) est fourni séparément, ne répète pas ces chiffres bruts — concentre-toi sur les tendances qualitatives dans la durée. Si un animateur n'a aucune synthèse hebdo ni donnée Kaizen ce mois-ci, une seule puce neutre suffit. Reste factuel, base-toi uniquement sur les données fournies. ATTENTION sur la rentabilité salariale (renta) : c'est un ratio coût salarial/CA où plus BAS est MEILLEUR — ne jamais qualifier une valeur supérieure à l'objectif de positive.

Réponds uniquement en JSON valide, sans texte avant/après, sans balises markdown, sous la forme :
IMPORTANT JSON : n'utilise JAMAIS le caractère guillemet droit (") à l'intérieur des valeurs de texte (ça casse le JSON) — utilise des guillemets français « » ou pas de guillemets du tout, y compris pour citer "Pour être dans le vert" ou tout autre nom entre guillemets.
{ "Nom Animateur 1": ["puce 1", "puce 2", "puce 3"], "Nom Animateur 2": [...], ... }
Utilise exactement les noms d'animateurs tels que donnés en entrée, comme clés.`;

let byArBullets = {};
if (weeklyRows.length && env.ANTHROPIC_API_KEY) {
const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4500, thinking: { type: 'disabled' }, system: systemPrompt, messages: [{ role: 'user', content: sections }] }),
});
const claudeData = await claudeResp.json();
if (claudeResp.ok) {
const rawText = (claudeData.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
try { byArBullets = extractJson(rawText); }
catch(e) { byArBullets = { 'Erreur': ['Réponse IA non-JSON : ' + e.message + ' | debug: ' + JSON.stringify({stop_reason: claudeData.stop_reason, contentBlockTypes: (claudeData.content || []).map(c => c.type), model: claudeData.model, usage: claudeData.usage}).slice(0, 500)] }; }
} else {
byArBullets = { 'Erreur': ['Erreur génération synthèse IA : ' + JSON.stringify(claudeData)] };
}
}

const subject = `Bilan mensuel réseau — ${moisLabel(from)}`;
return { subject, from, to, byAR, arStats, byArBullets, weeklyRowsCount: weeklyRows.length };
}

// Tableau taux entretiens / lancements par magasin (phase 3, 18/09 — révisé
// le 18/09 pour exclure Écoute&FB) — recadrage ET écoute_fb exclus du
// comptage (getEntretiensLancementsMap ne compte que pilotage_optique et
// pilotage_audio), un magasin sans donnée à 0%.
function htmlEntretiensLancementsTable(stores, map) {
const rows = stores.map(s => {
const d = map[s.code] || { tauxLancements: 0, tauxEntretiens: 0, nbVus: 0, nbEligibles: 0 };
return [s.libelle, `${d.tauxLancements}%`, `${d.tauxEntretiens}% (${d.nbVus}/${d.nbEligibles})`];
});
return `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">Suivi Managers — taux du mois</h3>` +
htmlStatsTable(['Magasin', 'Lancements de journée', 'Entretiens individuels'], rows);
}

async function sendMonthlyReport(env, override) {
const { subject, arStats, byArBullets } = await generateMonthlyReport(env, override);
const stores = await getMagasinsServerSide();
const entretiensLancementsMap = await getEntretiensLancementsMap(env);

const olivierTable = htmlStatsTable(
['Animateur', 'Magasins visités', 'Bilans', 'Humeur moy. /4', 'Durée moy.'],
arStats.map(s => [s.label, s.nbMagasins, s.nbBilans, formatHumeur(s.avgHumeur), formatDuree(s.avgDuree)])
);
const olivierBullets = htmlBulletSections(byArBullets);
const olivierSuiviManagers = htmlEntretiensLancementsTable(stores.filter(s => s.animateur), entretiensLancementsMap);
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject, bodyHtml: wrapEmailBody(olivierTable + olivierBullets + olivierSuiviManagers) });

for (const [ar, bullets] of Object.entries(byArBullets)) {
if (ar === 'Erreur') continue;
const arEmail = getArEmail(stores, ar);
if (!arEmail) continue;
const arBulletsHtml = htmlBulletSections({ [ar]: bullets });
const arStoresList = stores.filter(s => s.animateur === ar);
const arSuiviManagers = htmlEntretiensLancementsTable(arStoresList, entretiensLancementsMap);
try {
await zimbraSendMail(env, { to: arEmail, subject: `Bilan mensuel — ${ar}`, bodyHtml: wrapEmailBody(arBulletsHtml + arSuiviManagers) });
} catch(e) { console.error('Envoi bilan mensuel échoué pour', ar, e); }
}
}

// Jauge progressive (18/09) — même donnée que le tableau du bilan mensuel,
// mais affichée pendant le mois pour que les AR voient venir le retard avant
// la clôture plutôt que de le découvrir a posteriori dans le récap mensuel.
function htmlEntretiensLancementsGaugeSection(stores, map, scopeLabel) {
if (!stores.length) return '';
const moisActuelLabel = moisLabelKaizen(new Date().toISOString().slice(0, 7));
const title = `<h3 style="font-family:Arial,Helvetica,sans-serif;color:#CC1719;font-size:14px;margin:16px 0 6px;border-bottom:1px solid #CC1719;padding-bottom:3px">📋 Entretiens & lancements — ${moisActuelLabel} (en cours)</h3>`;
const rows = stores.map(s => {
const d = map[s.code] || { nbVus: 0, nbEligibles: 0, joursLances: 0, joursOuverts: 0 };
return [s.libelle, `${d.nbVus}/${d.nbEligibles}`, `${d.joursLances}/${d.joursOuverts || '?'}`];
});
return title + htmlStatsTable(['Magasin', 'Collaborateurs pilotés', 'Jours avec lancement'], rows);
}

async function sendWeeklyReport(env, override, arFilter) {
const { subject, from, to, byAR, byArBullets, coverage, unmatchedNames } = await generateWeeklyReport(env, override);
const stores = await getMagasinsServerSide();
const storeStatsCountMap = await getStoreStatsCountMap(env);
const lastVisitMap = await getLastVisitMap(env);
const lastObservationMap = await getLastObservationMap(env);
const lastBilanSnapshots = await getLastBilanSnapshots(env);
const stuckActionsAll = computeStuckActions(stores, lastBilanSnapshots);
const storeStatsMap = await getStoreStatsMap(env);
const stuckPedlvAll = await computeStuckPedlvItemsForStores(env, stores, storeStatsMap);
const entretiensLancementsMap = await getEntretiensLancementsMap(env);
const todayISO = new Date().toISOString().slice(0, 10);
const overdueAll = computeOverdueStores(stores, lastVisitMap, todayISO, lastObservationMap);
const lastVisitByLibelle = {};
stores.forEach(s => {
const bilanDate = lastVisitMap[s.code] || null;
const obsDate = lastObservationMap[normalizeName(s.libelle)] || null;
lastVisitByLibelle[normalizeName(s.libelle)] = [bilanDate, obsDate].filter(Boolean).sort().slice(-1)[0] || null;
});
const overdueCountByAr = {};
overdueAll.forEach(s => { overdueCountByAr[s.animateur] = (overdueCountByAr[s.animateur] || 0) + 1; });
// Observations Terrain (26/08) : un magasin observé sans bilan cette semaine
// doit compter dans "Magasins visités" (jamais dans "Bilans") — voir
// computeArStats et computeFullStoreStats.
const { byAR: obsByAR } = await getObservationsGroupedByAR(env, stores);
const obsMagasinsByAR = obsMagasinsCodesByAR(obsByAR);

if (!arFilter) {
const arStats = computeArStats(byAR, obsMagasinsByAR);
const olivierTable = htmlStatsTable(
['Animateur', 'Magasins visités', 'Bilans', 'Humeur moy. /4', 'Durée moy.', 'Pour être dans le vert', 'En retard (28j+)'],
arStats.map(s => {
const cov = coverage[s.label];
const covLabel = cov ? `${cov.withData.length}/${cov.withData.length + cov.withoutData.length}` : '—';
return [s.label, s.nbMagasins, s.nbBilans, formatHumeur(s.avgHumeur), formatDuree(s.avgDuree), covLabel, overdueCountCell(overdueCountByAr[s.label] || 0)];
})
);
const olivierBullets = htmlBulletSections(byArBullets);
const unmatchedSection = htmlUnmatchedNamesSection(unmatchedNames || []);
const stuckActionsSection = htmlStuckActionsSection(stuckActionsAll, 'du réseau');
const stuckPedlvSection = htmlStuckPedlvIndicateursSection(stuckPedlvAll, 'du réseau');
const gaugeSection = htmlEntretiensLancementsGaugeSection(stores.filter(s => s.animateur), entretiensLancementsMap, 'du réseau');
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject, bodyHtml: wrapEmailBody(olivierTable + olivierBullets + stuckActionsSection + stuckPedlvSection + unmatchedSection + gaugeSection) });
await saveWeeklyReport(env, 'bilan_hebdo', 'ALL', from, to, bulletsToText(byArBullets));
}

for (const [ar, bullets] of Object.entries(byArBullets)) {
if (ar === 'Erreur') continue;
if (arFilter && normalizeName(ar) !== normalizeName(arFilter)) continue;
if (!arFilter) await saveWeeklyReport(env, 'bilan_hebdo', ar, from, to, bulletsToText({ [ar]: bullets }));

const arEmail = getArEmail(stores, ar);
if (!arEmail) continue;
const arBilans = byAR[ar] || [];
const arStores = stores.filter(s => normalizeName(s.animateur) === normalizeName(ar));
const storeStats = arStores.length ? computeFullStoreStats(arStores, arBilans, lastObservationMap) : computeStoreStats(arBilans);
const arTable = storeStats.length
? htmlStatsTable(
['Magasin', 'Bilans', 'Dernière visite', 'Humeur moy. /4', 'Durée moy.', 'PEDLV (utilisations)'],
storeStats.map(s => [
s.label, s.nbBilans, lastVisitCell(lastVisitByLibelle[normalizeName(s.label)], todayISO), formatHumeur(s.avgHumeur), formatDuree(s.avgDuree),
storeStatsCountMap[normalizeName(s.label)] || 0,
])
)
: '';
const arBulletsHtml = htmlBulletSections({ [ar]: bullets });
const arStuckActions = stuckActionsAll.filter(a => normalizeName(a.animateur) === normalizeName(ar));
const arStuckActionsHtml = htmlStuckActionsSection(arStuckActions, 'de votre périmètre');
const arStuckPedlv = stuckPedlvAll.filter(i => normalizeName(i.animateur) === normalizeName(ar));
const arStuckPedlvHtml = htmlStuckPedlvIndicateursSection(arStuckPedlv, 'de votre périmètre');
const arGaugeHtml = htmlEntretiensLancementsGaugeSection(arStores, entretiensLancementsMap, 'de votre périmètre');
try {
await zimbraSendMail(env, { to: arEmail, subject: `Bilan hebdomadaire — ${ar}`, bodyHtml: wrapEmailBody(arTable + arBulletsHtml + arStuckActionsHtml + arStuckPedlvHtml + arGaugeHtml) });
} catch(e) { console.error('Envoi bilan hebdo échoué pour', ar, e); }
}
}

async function sendVisitReminders(env) {
const stores = await getMagasinsServerSide();
const lastVisitMap = await getLastVisitMap(env);
const lastObservationMap = await getLastObservationMap(env);
const todayISO = new Date().toISOString().slice(0, 10);
const overdueAll = computeOverdueStores(stores, lastVisitMap, todayISO, lastObservationMap);

// Digest score de santé (dérive / accumulation de signaux) — vient
// compléter cette même relance visite plutôt qu'un envoi séparé, comme
// discuté. Ne casse jamais l'envoi de la relance visite en cas de souci
// (ex: table store_health_score_history pas encore créée).
let healthDigestAll = [];
let noDataAll = [];
try {
const healthResult = await computeHealthDigest(env);
healthDigestAll = healthResult.digest;
noDataAll = healthResult.noData;
} catch(e) { console.error('Erreur calcul digest score de santé:', e); }

if (!overdueAll.length && !healthDigestAll.length) return;

const byAR = {};
overdueAll.forEach(s => {
(byAR[s.animateur] ??= { overdue: [], digest: [] }).overdue.push(s);
});
healthDigestAll.forEach(s => {
(byAR[s.animateur] ??= { overdue: [], digest: [] }).digest.push(s);
});

// Regroupement par AR des magasins sans assez de données pour un score — ne crée
// jamais d'envoi à lui seul (ne modifie pas byAR), vient seulement enrichir
// un mail déjà déclenché par un retard ou un signal de santé cette semaine-là.
const noDataByAr = {};
noDataAll.forEach(s => { (noDataByAr[s.animateur] ??= []).push(s); });

for (const [ar, { overdue, digest }] of Object.entries(byAR)) {
const arEmail = getArEmail(stores, ar);
if (!arEmail) continue;
const subjectBits = [];
if (overdue.length) subjectBits.push(`${overdue.length} en retard`);
if (digest.length) subjectBits.push(`${digest.length} à surveiller`);
try {
await zimbraSendMail(env, {
to: arEmail,
subject: `⚠️ Relance visite — ${subjectBits.join(' · ')}`,
bodyHtml: wrapEmailBody(htmlOverdueSection(overdue, 'de votre périmètre') + htmlHealthDigestSection(digest, 'de votre périmètre', noDataByAr[ar] || [])),
});
} catch(e) { console.error('Envoi relance visite échoué pour', ar, e); }
}

try {
const subjectBits = [];
if (overdueAll.length) subjectBits.push(`${overdueAll.length} en retard`);
if (healthDigestAll.length) subjectBits.push(`${healthDigestAll.length} à surveiller`);
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `⚠️ Relance visite — ${subjectBits.join(' · ')} sur le réseau`,
bodyHtml: wrapEmailBody(htmlOverdueSection(overdueAll, 'du réseau') + htmlHealthDigestSection(healthDigestAll, 'du réseau', noDataAll)),
});
} catch(e) { console.error('Envoi relance visite (réseau) échoué:', e); }
}

function stripJsonFences(text) {
let t = text.trim();
t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
return t.trim();
}

function repairEscapedUnicode(str) {
return str.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function repairEscapedUnicodeDeep(value) {
if (typeof value === 'string') return repairEscapedUnicode(value);
if (Array.isArray(value)) return value.map(repairEscapedUnicodeDeep);
if (value && typeof value === 'object') {
const out = {};
for (const [k, v] of Object.entries(value)) out[k] = repairEscapedUnicodeDeep(v);
return out;
}
return value;
}

function extractJson(text) {
const cleaned = stripJsonFences(text);
try {
return repairEscapedUnicodeDeep(JSON.parse(cleaned));
} catch (e) {
const match = cleaned.match(/\{[\s\S]*\}/);
if (match) {
try {
return repairEscapedUnicodeDeep(JSON.parse(match[0]));
} catch (e2) {
throw enrichJsonParseError(e2, match[0]);
}
}
throw enrichJsonParseError(e, cleaned);
}
}

// V8 inclut la position du caractère fautif dans le message d'erreur de
// JSON.parse ("... at position 1234"). On s'en sert pour extraire un
// contexte AUTOUR du vrai point de casse, plutôt que de toujours logger le
// début du texte — inutile si le problème est plus loin (cas réel du 06/09,
// où les 1500 premiers caractères affichés à Olivier ne montraient jamais
// l'endroit du bug).
function enrichJsonParseError(err, text) {
const m = /position (\d+)/.exec(err.message || '');
if (!m) return err;
const pos = parseInt(m[1], 10);
const debut = Math.max(0, pos - 300);
const fin = Math.min(text.length, pos + 300);
const contexte = text.slice(debut, fin);
return new Error(err.message + ' | contexte autour du caractère ' + pos + ' : ...' + contexte + '...');
}

// Regroupe les observations terrain (table `observations`, alimentée par
// l'app Observations Terrain) par animateur, pour les intégrer au com hebdo
// du dimanche (ajouté le 21/08 — jusque-là seul le bouton manuel de l'app,
// retiré le même jour, communiquait ce contenu). Rattachement par libellé
// magasin exact (normalizeName), cohérent avec le reste du système : depuis
// le 21/08 la liste de magasins de l'app vient de magasins.csv, donc les
// libellés reçus correspondent déjà — sauf residus d'avant cette date, ou
// entrées "Info generale" non rattachées à un magasin. Ces deux cas partent
// dans `networkOnly` : visibles dans le com hebdo réseau, jamais dans un com
// hebdo par AR puisqu'on ne sait pas à qui les rattacher.
async function getObservationsGroupedByAR(env, stores) {
if (!env.DB) return { byAR: {}, networkOnly: [] };
let results;
try {
({ results } = await env.DB.prepare('SELECT magasin, theme, tone, texte, jour_label FROM observations ORDER BY id').all());
} catch(e) { return { byAR: {}, networkOnly: [] }; }
const storeByName = new Map(stores.map(s => [normalizeName(s.libelle), s]));
const byAR = {};
const networkOnly = [];
for (const r of results) {
if (r.magasin === 'Info generale') { networkOnly.push(r); continue; }
const store = storeByName.get(normalizeName(r.magasin));
if (!store || !store.animateur) { networkOnly.push(r); continue; }
(byAR[store.animateur] ??= []).push({ ...r, storeCode: store.code, storeLibelle: store.libelle });
}
return { byAR, networkOnly };
}

// Réduit le résultat de getObservationsGroupedByAR à {ar: Set(codes magasin)},
// pour compter les magasins "visités via observation" dans le bilan hebdo
// (26/08) sans dupliquer un observation = un bilan — un magasin avec 3
// observations la même semaine ne compte que pour 1 magasin visité.
function obsMagasinsCodesByAR(obsByAR) {
const out = {};
for (const [ar, list] of Object.entries(obsByAR)) {
out[ar] = new Set(list.map(r => r.storeCode).filter(Boolean));
}
return out;
}

function formatObservationLine(r) {
return `[${r.jour_label || ''}][${r.magasin}][${r.theme}][${r.tone === 'p' ? '+' : '-'}] ${r.texte}`;
}

// Clôture de journée Observations Terrain (22/08) : à chaque clic sur
// "Terminer la journée" côté client, un mail par magasin visité ce jour-là,
// envoyé à Olivier uniquement, en plus du com hebdo automatique du dimanche
// (inchangé). Le contenu vient directement du client (déjà en mémoire côté
// app, jamais reconstitué depuis D1 par date seule) pour ne jamais mélanger
// les observations d'un autre AR saisies le même jour sur d'autres magasins.
// Le magasin reçu (libellé tel que choisi dans le menu déroulant, donc déjà
// fiable) est résolu en code + libellé officiel via magasins.csv, même
// logique que getObservationsGroupedByAR.
async function sendObsDayCloseEmails(env, { ar, date, dateLabel, items }) {
const stores = await getMagasinsServerSide();
const storeByName = new Map(stores.map(s => [normalizeName(s.libelle), s]));
const dateAffichee = dateLabel || date || '';
const arAffiche = ar || 'non renseigné';

const byMagasin = {};
for (const it of items) {
(byMagasin[it.m] ??= []).push(it);
}

let sent = 0;
const erreurs = [];
for (const [magasinRecu, obsList] of Object.entries(byMagasin)) {
const store = storeByName.get(normalizeName(magasinRecu));
const libelle = store ? store.libelle : magasinRecu;
const code = store ? store.code : '?';
const items_html = obsList.map(o => `<div style="margin-bottom:10px"><div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#888884;margin-bottom:2px">${escapeHtml(o.th)} — ${o.t === 'p' ? 'Positif' : 'A ameliorer'}</div><div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A">${encodeAstralAsHtmlEntities(escapeHtml(o.tx))}</div></div>`).join('');
const bodyHtml = wrapEmailBody(
`<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 14px"><b>Animateur :</b> ${escapeHtml(arAffiche)}<br><b>Magasin :</b> ${escapeHtml(libelle)} (${escapeHtml(code)})<br><b>Date :</b> ${escapeHtml(dateAffichee)}</p>` + items_html
);
const subject = `Observation terrain — ${dateAffichee} — ${libelle}`;
try {
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject, bodyHtml });
sent++;
} catch (e) {
erreurs.push(`${magasinRecu}: ${String(e)}`);
}
// Copie à l'animateur réseau du magasin (28/08, demande d'Olivier) — résolution
// côté serveur via magasins.csv (`animateurEmail`), jamais via le filtre AR affiché
// à l'écran côté client, cohérent avec le reste du système (bilan hebdo, com hebdo).
// Envoi séparé de celui d'Olivier (même pattern que sendWeeklyReport/sendComHebdo),
// dans un try/catch dédié : un échec ici ne doit jamais faire perdre le mail à
// Olivier, et inversement.
if (store && store.animateurEmail && store.animateurEmail !== OLIVIER_EMAIL) {
try {
await zimbraSendMail(env, { to: store.animateurEmail, subject, bodyHtml });
} catch (e) {
erreurs.push(`${magasinRecu} (AR ${store.animateur || '?'}): ${String(e)}`);
}
}
}
return { sent, total: Object.keys(byMagasin).length, erreurs };
}

async function generateComHebdoCore(contentSource, framing, env) {
if (!env.ANTHROPIC_API_KEY) throw new Error('Clé API Anthropic non configurée sur le Worker');

const systemPrompt = `Tu aides à rédiger une communication hebdomadaire interne à partir des remontées terrain de la semaine (bilans de passage, indicateurs, observations), ${framing}.

RÈGLES DE STYLE (à respecter strictement) :
- Ton motivant, jamais alarmiste.
- Ne JAMAIS pointer un magasin par son nom sur un point négatif — rester général ou parler de tendances plutôt que de nommer un magasin en difficulté.
- Cite toujours les magasins par leur nom (jamais par un prénom de manager ou un surnom) quand tu les mentionnes positivement.
- Tu écris en français.
- ATTENTION sur la rentabilité salariale (renta) : c'est un ratio coût salarial/CA où plus BAS est MEILLEUR — ne jamais qualifier une valeur supérieure à l'objectif de positive.

FORMATS ATTENDUS (réponds uniquement en JSON valide, sans texte avant/après, sans balises markdown) :
IMPORTANT JSON : n'utilise JAMAIS le caractère guillemet droit (") à l'intérieur des valeurs de texte (ça casse le JSON) — utilise des guillemets français « » ou pas de guillemets du tout, y compris pour citer "Pour être dans le vert" ou tout autre nom entre guillemets.
{
"slack1": {"titre": "emoji + titre court", "contenu": "1-2 phrases courtes, concises, sans détail superflu", "conclusion": "1 phrase percutante et brève"},
"slack2": {"titre": "emoji + titre court (angle différent de slack1)", "contenu": "1-2 phrases courtes, concises, sans détail superflu", "conclusion": "1 phrase percutante et brève"},
"slack3": {"titre": "emoji + titre court (angle différent de slack1 et slack2)", "contenu": "1-2 phrases courtes, concises, sans détail superflu", "conclusion": "1 phrase percutante et brève"},
"message_general": "message autonome avec emojis, 4-8 phrases, ton motivant, à poster tel quel",
"email_objet": "objet de l'email, sans emoji",
"email_corps": "email narratif plus long (8-15 phrases), SANS AUCUN EMOJI (contrainte technique Zimbra), ton professionnel et motivant"
}

IMPORTANT sur la longueur des messages Slack (slack1/slack2/slack3) : reste bref — vise un texte total (titre + contenu + conclusion) réduit d'environ un tiers par rapport à ce qui te semblerait naturel pour un message Slack. Va droit au but, une idée par message, pas de justification détaillée. Le message général et l'email, eux, gardent leur longueur habituelle.

Les 3 messages Slack doivent couvrir des angles différents (ex: un fait marquant de la semaine, un point de vigilance sans nommer de magasin, un encouragement/objectif pour la semaine à venir) — évite les répétitions entre eux.`;

const userPrompt = `Voici les remontées terrain de la semaine :\n\n${contentSource}`;

const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5000, thinking: { type: 'disabled' }, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
});
const claudeData = await claudeResp.json();
if (!claudeResp.ok) throw new Error('Erreur API Claude : ' + JSON.stringify(claudeData));

const rawText = (claudeData.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
try {
return extractJson(rawText);
} catch (e) {
throw new Error('Réponse IA non-JSON, impossible à parser : ' + e.message + ' | debug: ' + JSON.stringify({stop_reason: claudeData.stop_reason, contentBlockTypes: (claudeData.content || []).map(c => c.type), model: claudeData.model, usage: claudeData.usage}).slice(0, 500));
}
}

async function generateComHebdo(env, override) {
const { from, to, byAR } = await getWeekData(env, override);
const stores = await getMagasinsServerSide();
const storeStatsMap = await getStoreStatsMap(env);
const coverage = buildArStoreCoverage(stores, storeStatsMap);
const kaizenNotStartedByAR = await getKaizenNotStartedByAR(env);
const { byAR: obsByAR, networkOnly: obsNetworkOnly } = await getObservationsGroupedByAR(env, stores);

const sections = Object.entries(byAR)
.filter(([, list]) => list.length)
.map(([ar, list]) => `=== ${ar} (${list.length} bilan(s)) ===\n` + list.map(b => resumeBilan(b, { includeHumeur: false })).join('\n\n---\n\n'))
.join('\n\n\n');

const totalWithData = Object.values(coverage).reduce((s, c) => s + c.withData.length, 0);
const totalStores = Object.values(coverage).reduce((s, c) => s + c.withData.length + c.withoutData.length, 0);
const statsLines = Object.entries(coverage)
.filter(([, c]) => c.withData.length)
.map(([ar, c]) => `${ar} :\n` + c.withData.map(storeStatsSummaryText).join('\n'))
.join('\n\n');
const kzLines = Object.entries(kaizenNotStartedByAR)
.map(([ar, list]) => `${ar} : ${list.join(', ')}`)
.join('\n');
const obsAllLines = [...Object.values(obsByAR).flat(), ...obsNetworkOnly].map(formatObservationLine).join('\n');

const contentSource = [
sections || '(Aucun bilan de passage enregistré cette semaine sur le réseau.)',
statsLines
? `\n\nDonnées «Pour être dans le vert» cette semaine (${totalWithData}/${totalStores} magasins ont transmis) :\n${statsLines}`
: `\n\n(Aucun magasin n'a transmis de données «Pour être dans le vert» cette semaine, sur ${totalStores} magasins au total.)`,
kzLines ? `\n\nAudits Kaizen du mois pas encore commencés :\n${kzLines}` : '',
obsAllLines ? `\n\nObservations terrain de la semaine :\n${obsAllLines}` : '',
].join('');

const blocks = await generateComHebdoCore(contentSource, 'pour le directeur réseau qui communique sur l\'ensemble du réseau Optical Center', env);
return { from, to, blocks, coverage };
}

async function generateComHebdoForAR(arName, arBilans, arCoverage, env, kaizenNotStarted, arObservations) {
const bilanSource = arBilans.length
? arBilans.map(b => resumeBilan(b, { includeHumeur: false })).join('\n\n---\n\n')
: '(Aucun bilan de passage enregistré cette semaine pour ces magasins.)';

let statsSource = '';
if (arCoverage) {
if (arCoverage.withData.length) statsSource += `\n\nDonnées «Pour être dans le vert» :\n` + arCoverage.withData.map(storeStatsSummaryText).join('\n');
if (arCoverage.withoutData.length) statsSource += `\n\nMagasins sans données «Pour être dans le vert» cette semaine : ${arCoverage.withoutData.join(', ')}.`;
}
if (kaizenNotStarted && kaizenNotStarted.length) {
statsSource += `\n\nAudit Kaizen du mois pas encore commencé pour : ${kaizenNotStarted.join(', ')}.`;
}
if (arObservations && arObservations.length) {
statsSource += `\n\nObservations terrain de la semaine :\n` + arObservations.map(formatObservationLine).join('\n');
}

const blocks = await generateComHebdoCore(bilanSource + statsSource, `pour l'animateur réseau ${arName} qui communique à son équipe sur ses propres magasins`, env);
return blocks;
}

function formatComHebdoAsEmail(blocks) {
return [
`--- SLACK 1 ---`,
`${blocks.slack1?.titre}\n${blocks.slack1?.contenu}\n${blocks.slack1?.conclusion}`,
``,
`--- SLACK 2 ---`,
`${blocks.slack2?.titre}\n${blocks.slack2?.contenu}\n${blocks.slack2?.conclusion}`,
``,
`--- SLACK 3 ---`,
`${blocks.slack3?.titre}\n${blocks.slack3?.contenu}\n${blocks.slack3?.conclusion}`,
``,
`--- MESSAGE GÉNÉRAL ---`,
blocks.message_general,
``,
`--- EMAIL (objet: ${blocks.email_objet}) ---`,
blocks.email_corps,
].join('\n');
}

async function sendComHebdo(env, override, arFilter) {
const { from, to, blocks } = await generateComHebdo(env, override);
const subjectPrefix = `Com hebdo (brouillon) — semaine du ${from.split('-').reverse().join('/')} au ${to.split('-').reverse().join('/')}`;

if (!arFilter) {
// Note (23/08) : pas de section "Noms non reconnus (Pour être dans le vert)" ici —
// déjà présente dans le bilan hebdomadaire du samedi (sendWeeklyReport), doublon
// jugé inutile par Olivier.
let networkBody = formatComHebdoAsEmail(blocks);
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject: subjectPrefix + ' — réseau complet', bodyText: networkBody });
await saveWeeklyReport(env, 'com_hebdo', 'ALL', from, to, formatComHebdoAsEmail(blocks));
}

const { byAR } = await getWeekData(env, override || { from, to });
const stores = await getMagasinsServerSide();
const storeStatsMap = await getStoreStatsMap(env);
const coverage = buildArStoreCoverage(stores, storeStatsMap);
const kaizenNotStartedByAR = await getKaizenNotStartedByAR(env);
const { byAR: obsByAR } = await getObservationsGroupedByAR(env, stores);
const failures = [];

const arEntries = arFilter ? [[arFilter, byAR[arFilter] || []]] : Object.entries(byAR);
for (const [ar, arBilans] of arEntries) {
const arCov = coverage[ar];
const hasStats = arCov && arCov.withData.length > 0;
const kzNotStarted = kaizenNotStartedByAR[ar] || [];
const arObs = obsByAR[ar] || [];
if (!arFilter && !arBilans.length && !hasStats && !kzNotStarted.length && !arObs.length) continue;
const arEmail = getArEmail(stores, ar);
if (!arEmail) {
failures.push({ ar, reason: "aucun email configuré (colonne animateur_email manquante dans magasins.csv)" });
continue;
}
try {
const arBlocks = await generateComHebdoForAR(ar, arBilans, arCov, env, kzNotStarted, arObs);
await saveWeeklyReport(env, 'com_hebdo', ar, from, to, formatComHebdoAsEmail(arBlocks));
await zimbraSendMail(env, { to: arEmail, subject: subjectPrefix + ` — ${ar}`, bodyText: formatComHebdoAsEmail(arBlocks) });
} catch(e) {
console.error('Envoi com hebdo échoué pour', ar, e);
failures.push({ ar, reason: (e && e.message) ? e.message : String(e) });
}
}

if (failures.length) {
const anomaliesBody = [
`--- COMS NON ENVOYÉES CETTE SEMAINE ---`,
failures.map(f => `${f.ar} : ${f.reason}`).join('\n\n'),
].join('\n');
try {
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject: subjectPrefix + (arFilter ? ` — ⚠️ échec renvoi ${arFilter}` : ' — ⚠️ anomalies'), bodyText: anomaliesBody });
} catch(e) { console.error('Envoi du mail anomalies com hebdo échoué:', e); }
}
return { failures };
}

// ============================================================
// Évaluation Équipe — support (ajouté 06/08/2026)
// ============================================================

const OBJECTIF_NIVEAU_EQUIPE = 8.0;

function anneeCouranteEval() {
return new Date().getUTCFullYear();
}

// Carte {magasin_code: niveau_equipe} pour TOUS les magasins ayant au moins une
// note cette année — réutilisée par /store-health pour intégrer le niveau
// équipe au score de santé, sans dupliquer la logique de /evaluation/reseau
// (qui reste inchangée pour ne pas prendre de risque sur une route déjà en prod).
async function getNiveauxEquipeMap(env) {
if (!env.DB) return {};
try {
const annee = anneeCouranteEval();
const { results: notes } = await env.DB.prepare(`
SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?
`).bind(annee).all();

const parMagasin = {};
for (const n of notes) {
const m = (parMagasin[n.magasin_code] ??= {});
(m[n.tache] ??= []).push(n.note);
}

const niveaux = {};
for (const [code, taches] of Object.entries(parMagasin)) {
const moyennes = Object.values(taches).map(notesArr => {
const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
return top3.reduce((s, n) => s + n, 0) / top3.length;
});
niveaux[code] = moyennes.length
? Math.round((moyennes.reduce((s, m2) => s + m2, 0) / moyennes.length) * 10) / 10
: null;
}
return niveaux;
} catch (e) {
console.error('Erreur calcul niveaux équipe (store-health):', e);
return {};
}
}

async function buildNiveauxEvalCsv(env) {
const annee = anneeCouranteEval();
const magasinsRef = await getMagasinsServerSide();

const { results: notes } = await env.DB.prepare(`
SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?
`).bind(annee).all();

const { results: taches } = await env.DB.prepare(`
SELECT DISTINCT tache FROM criteres_taches WHERE active_depuis_annee <= ? ORDER BY tache
`).bind(annee).all();
const nomsTaches = taches.map(t => t.tache);

const parMagasin = {};
for (const n of notes) {
const m = (parMagasin[n.magasin_code] ??= {});
(m[n.tache] ??= []).push(n.note);
}

const header = ['Code magasin', 'Magasin', 'AR', ...nomsTaches, 'Niveau équipe', 'Objectif', 'Écart'];
const lignes = [header];

for (const mag of magasinsRef) {
const parTache = parMagasin[mag.code] || {};
const moyennesParTache = nomsTaches.map(t => {
const notesArr = parTache[t];
if (!notesArr || !notesArr.length) return '';
const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
return (top3.reduce((s, n) => s + n, 0) / top3.length).toFixed(1);
});
const valeurs = moyennesParTache.filter(v => v !== '').map(Number);
const niveau = valeurs.length ? valeurs.reduce((s, v) => s + v, 0) / valeurs.length : null;
const ecart = niveau != null ? (niveau - OBJECTIF_NIVEAU_EQUIPE).toFixed(1) : '';

lignes.push([
mag.code, mag.libelle, mag.animateur || '',
...moyennesParTache,
niveau != null ? niveau.toFixed(1) : '',
OBJECTIF_NIVEAU_EQUIPE.toFixed(1),
ecart,
]);
}

return lignes.map(row => row.map(csvEscapeEval).join(';')).join('\r\n');
}

function csvEscapeEval(v) {
const s = String(v ?? '');
return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function envoyerExportMensuelEval(env) {
if (!env.DB) return;

const annee = anneeCouranteEval();
const magasinsRef = await getMagasinsServerSide();

const { results: notes } = await env.DB.prepare(`
SELECT magasin_code, tache, note FROM notes_equipe WHERE annee = ?
`).bind(annee).all();

const parMagasin = {};
for (const n of notes) {
const m = (parMagasin[n.magasin_code] ??= {});
(m[n.tache] ??= []).push(n.note);
}

const rows = magasinsRef.map(mag => {
const parTache = parMagasin[mag.code] || {};
const moyennes = Object.values(parTache).map(notesArr => {
const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
return top3.reduce((s, n) => s + n, 0) / top3.length;
});
const niveau = moyennes.length ? moyennes.reduce((s, m2) => s + m2, 0) / moyennes.length : null;
return [mag.libelle, mag.code, mag.animateur || '', niveau != null ? niveau.toFixed(1) : '—'];
});

const table = htmlStatsTable(['Magasin', 'Code', 'AR', 'Niveau équipe'], rows);
try {
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `Évaluation Équipe — export réseau ${annee}`,
bodyHtml: wrapEmailBody(table),
});
} catch (e) {
console.error('Erreur envoi export mensuel Évaluation Équipe:', e);
}
}

// Rappel mensuel (22/08) : chaque 1er du mois, Olivier doit charger le fichier
// RH (effectif/poste/genre) et le fichier Absences du mois qui vient de se
// terminer sur la page d'import de l'indicateur RH. Casé sur le cron mensuel
// existant (1er du mois, 8h UTC) plutôt que d'en créer un nouveau — le plafond
// de 5 Cron Triggers du plan gratuit Cloudflare est déjà atteint.
async function sendRhImportReminder(env) {
const moisEcoule = moisLabelKaizen(moisPrecedent());
const bodyHtml = wrapEmailBody(
`<p style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#2C2C2A;margin:0 0 12px">Pensez à charger le fichier RH (effectif/poste/genre) et le fichier Absences de <b>${moisEcoule}</b> sur la page d'import :</p>` +
`<p style="margin:0 0 12px"><a href="https://olibaroukh.github.io/bilan-passage/import.html" style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#CC1719">https://olibaroukh.github.io/bilan-passage/import.html</a></p>`
);
try {
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `Rappel — import RH & Absences (${moisEcoule})`,
bodyHtml,
});
} catch (e) {
console.error('Erreur envoi rappel import RH:', e);
}
}

// Trace légère de chaque appel IA /analyze (magasin unique ou tournée) pour
// pouvoir répondre plus tard à "qu'est-ce qui a coûté cher ce jour-là" sans
// dépendre des logs Cloudflare (retenus 3 jours seulement) ni deviner. Ne
// doit jamais faire échouer l'analyse elle-même si l'écriture D1 rate.
async function logAnalyzeCall(env, { ar, mode, nbMagasins, inputTokens, outputTokens }) {
if (!env.DB) return;
try {
await env.DB.prepare(
`INSERT INTO analyze_calls_log (ar, mode, nb_magasins, input_tokens, output_tokens, called_at) VALUES (?, ?, ?, ?, ?, ?)`
).bind(ar || null, mode || null, nbMagasins ?? null, inputTokens ?? null, outputTokens ?? null, new Date().toISOString()).run();
} catch(e) { console.error('Erreur log analyze_calls_log:', e); }
}

// Enveloppe chaque job planifié : en cas d'échec, envoie une alerte email à
// Olivier en plus du console.error (les logs Cloudflare ne sont retenus que
// 3 jours et ne sont pas surveillés activement — sans ça, un job qui plante
// avant d'avoir pu envoyer ses propres emails est invisible, silencieusement,
// jusqu'à ce que quelqu'un remarque l'absence d'un rapport). N'avale jamais
// l'erreur d'origine sans la logger, et si même l'envoi de l'alerte échoue
// (Zimbra down par exemple), on le logge aussi plutôt que de perdre l'info.
async function withCronAlert(env, jobName, fn) {
try {
await fn();
} catch (e) {
console.error(`Erreur ${jobName}:`, e);
try {
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `⚠️ Échec cron — ${jobName}`,
bodyText: `Le job planifié "${jobName}" a échoué le ${new Date().toISOString()}.\n\nErreur :\n${e && e.stack ? e.stack : String(e)}`,
});
} catch (mailErr) {
console.error(`Échec de l'ENVOI de l'alerte cron pour ${jobName} (en plus de l'erreur d'origine) :`, mailErr);
}
}
}

export default {
async fetch(request, env) {
const corsHeaders = {
'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
'Access-Control-Allow-Headers': 'Content-Type, X-Zimbra-Auth-Token, X-Notify-Token, X-Store-Token, X-AR-Session, X-Accomp-Session',
'Access-Control-Max-Age': '86400',
};

if (request.method === 'OPTIONS') {
return new Response(null, { status: 204, headers: corsHeaders });
}

const url = new URL(request.url);

if (request.method !== 'POST' && !(request.method === 'GET' && (url.pathname === '/bilans' || url.pathname === '/test-weekly-report' || url.pathname === '/com-hebdo' || url.pathname === '/test-com-hebdo' || url.pathname === '/test-monthly-report' || url.pathname === '/test-kaizen-cloture' || url.pathname === '/google-ratings' || url.pathname === '/test-google-ratings-refresh' || url.pathname === '/test-visit-reminders' || url.pathname === '/store-health' || url.pathname === '/store-health-detail' || url.pathname === '/ar-dashboard' || url.pathname === '/last-actions' || url.pathname === '/evaluation/magasin' || url.pathname === '/evaluation/reseau' || url.pathname === '/evaluation/export-reseau' || url.pathname === '/kaizen-etat' || url.pathname === '/kaizen-historique' || url.pathname === '/kaizen-photo' || url.pathname === '/debug-magasins-non-reconnus' || url.pathname === '/rh-effectif' || url.pathname === '/accompagnement-list' || url.pathname === '/accompagnement-get' || url.pathname === '/historique-managers' || url.pathname === '/collab-stats' || url.pathname === '/rh-collaborateurs' || url.pathname === '/store-monthly-stats'))) {
return new Response('Méthode non autorisée', { status: 405, headers: corsHeaders });
}

try {
if (url.pathname === '/upload') {
const token = request.headers.get('X-Zimbra-Auth-Token');
if (!token) {
return new Response('Jeton manquant', { status: 400, headers: corsHeaders });
}
const contentType = request.headers.get('Content-Type') || '';
const bodyBuffer = await request.arrayBuffer();
const uploadRes = await fetch(ZIMBRA_UPLOAD_URL, {
method: 'POST',
headers: { 'Content-Type': contentType, 'Cookie': `ZM_AUTH_TOKEN=${token}` },
body: bodyBuffer,
});
const text = await uploadRes.text();
return new Response(text, {
status: uploadRes.status,
headers: { 'Content-Type': 'text/plain', ...corsHeaders },
});
}

if (url.pathname === '/notify') {
const notifyToken = request.headers.get('X-Notify-Token');
if (notifyToken !== NOTIFY_SECRET) {
return new Response('Non autorisé', { status: 401, headers: corsHeaders });
}
const { to, subject, body, zimbraUser, zimbraPass } = await request.json();
if (!to || !subject || !body || !zimbraUser || !zimbraPass) {
return new Response('Paramètres manquants', { status: 400, headers: corsHeaders });
}
const authResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
Body: {
AuthRequest: {
_jsns: 'urn:zimbraAccount',
account: { by: 'name', _content: zimbraUser },
password: { _content: zimbraPass }
}
}
})
});
const authData = await authResp.json();
const token = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
if (!token) {
return new Response('Auth Zimbra échouée', { status: 401, headers: corsHeaders });
}
const sendResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'Cookie': `ZM_AUTH_TOKEN=${token}` },
body: JSON.stringify({
Header: {
context: {
_jsns: 'urn:zimbra',
format: { _content: 'js', type: 'js' },
authToken: [{ _content: token }]
}
},
Body: {
SendMsgRequest: {
_jsns: 'urn:zimbraMail',
m: {
su: { _content: subject },
e: [{ t: 't', a: to }],
mp: { ct: 'text/plain', content: { _content: body } }
}
}
}
})
});
const sendText = await sendResp.text();
return new Response(sendText, {
status: sendResp.status,
headers: { 'Content-Type': 'application/json', ...corsHeaders }
});
}

if (url.pathname === '/ar-login') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);

const { zimbraUser, zimbraPass } = await request.json();
if (!zimbraUser || !zimbraPass) return jsonError('Identifiant et mot de passe requis', 400, corsHeaders);

const authResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
Body: {
AuthRequest: {
_jsns: 'urn:zimbraAccount',
account: { by: 'name', _content: zimbraUser },
password: { _content: zimbraPass }
}
}
})
});
const authData = await authResp.json();
const zimbraToken = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
if (!zimbraToken) return jsonError('Identifiants Zimbra invalides', 401, corsHeaders);

const localPart = zimbraUser.split('@')[0];
const normalizedLogin = normalizeName(localPart);
let ar = null;
if (normalizedLogin.includes('baroukh')) {
ar = 'ALL';
} else {
const stores = await getMagasinsServerSide();
const emailLogin = (zimbraUser || '').trim().toLowerCase();
// 1. Correspondance directe et fiable : l'email utilisé pour l'authentification
// Zimbra est comparé à la colonne `animateur_email`, déjà utilisée pour l'envoi
// des mails automatiques aux AR (donc déjà validée par l'usage, pas une heuristique).
const emailMatch = stores.find(s => s.animateurEmail && s.animateurEmail.trim().toLowerCase() === emailLogin);
if (emailMatch) {
ar = emailMatch.animateur;
} else {
// 2. Repli sur l'heuristique par nom normalisé, pour les magasins dont
// `animateur_email` ne serait pas encore renseigné dans magasins.csv.
const uniqueARs = [...new Set(stores.map(s => s.animateur).filter(Boolean))];
ar = uniqueARs.find(a => normalizeName(a) === normalizedLogin) || null;
}
}
if (!ar) {
// Le mot de passe Zimbra vient d'être vérifié pour de vrai juste au-dessus —
// donc ce n'est jamais un inconnu qui déclenche cette alerte, seulement la
// résolution d'identité qui échoue. On prévient Olivier pour qu'il puisse
// corriger magasins.csv sans attendre que l'AR le lui signale lui-même.
// `fetch(request, env)` n'a pas de `ctx` ici (pas de waitUntil disponible) —
// on attend l'envoi avant de répondre, léger surcoût acceptable sur ce
// chemin d'erreur rare.
try {
await zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `⚠️ Connexion Analyse échouée — aucun AR ne correspond`,
bodyText: `Identifiants Zimbra valides pour "${zimbraUser}", mais aucun animateur ne correspond dans magasins.csv (ni par email, ni par nom).\n\nÀ corriger dans magasins.csv : vérifier que la colonne "animateur_email" contient bien "${zimbraUser}" pour cette personne, ou à défaut que la colonne "animateur" suit le motif prenom.nom attendu (login testé : "${normalizedLogin}").`,
});
} catch (e) { console.error('Échec envoi alerte ar-login:', e); }
return jsonError("Identifiants valides mais aucun animateur ne correspond à '" + zimbraUser + "' dans le référentiel magasins. Vérifie la colonne animateur_email (ou à défaut animateur) dans magasins.csv.", 403, corsHeaders);
}

const sessionToken = await createArSession(ar);
return new Response(JSON.stringify({ ok: true, sessionToken, ar, expiresInMs: AR_SESSION_TTL_MS, zimbraToken }), {
status: 200,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/accompagnement-login') {
const { user, pass } = await request.json();
if (!user || !pass) return jsonError('Identifiant et mot de passe requis', 400, corsHeaders);
const emailLower = user.trim().toLowerCase();
if (!ACCOMP_ALLOWED_EMAILS.includes(emailLower)) {
return jsonError("Cet identifiant n'est pas autorisé sur Accompagnement Manager.", 403, corsHeaders);
}
const authResp = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
Header: { context: { _jsns: 'urn:zimbra', format: { _content: 'js', type: 'js' } } },
Body: {
AuthRequest: {
_jsns: 'urn:zimbraAccount',
account: { by: 'name', _content: user },
password: { _content: pass }
}
}
})
});
const authData = await authResp.json();
const zimbraToken = authData?.Body?.AuthResponse?.authToken?.[0]?._content;
if (!zimbraToken) return jsonError('Identifiants Zimbra invalides', 401, corsHeaders);
const localPart = user.split('@')[0];
const nom = localPart.split('.').map(p => p ? p.charAt(0).toUpperCase() + p.slice(1) : p).join(' ');
const token = await createAccompSession(emailLower, nom);
return new Response(JSON.stringify({ ok: true, token, nom, zimbraToken }), {
status: 200,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/accompagnement-save') {
const { session, error } = await requireAccompSession(request, corsHeaders);
if (error) return error;
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const data = await request.json();
if (!data.magasin_code || !data.date_visite) {
return jsonError('Champs requis manquants (magasin_code, date_visite)', 400, corsHeaders);
}
if (data.id) {
await env.DB.prepare(
`UPDATE accompagnements SET magasin_code=?, magasin_libelle=?, manager=?, itinerant=?, date_visite=?, contenu_json=?, updated_at=datetime('now')
WHERE id=? AND statut='brouillon'`
).bind(
data.magasin_code, data.magasin_libelle || '', data.manager || '',
data.itinerant || session.nom, data.date_visite, data.contenu_json || '{}', data.id
).run();
return new Response(JSON.stringify({ ok: true, id: data.id }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} else {
const result = await env.DB.prepare(
`INSERT INTO accompagnements (magasin_code, magasin_libelle, manager, itinerant, date_visite, statut, contenu_json)
VALUES (?, ?, ?, ?, ?, 'brouillon', ?)`
).bind(
data.magasin_code, data.magasin_libelle || '', data.manager || '',
data.itinerant || session.nom, data.date_visite, data.contenu_json || '{}'
).run();
return new Response(JSON.stringify({ ok: true, id: result.meta.last_row_id }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}
}

if (url.pathname === '/accompagnement-get') {
const { session, error } = await requireAccompSession(request, corsHeaders);
if (error) return error;
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const id = url.searchParams.get('id');
if (!id) return jsonError('Paramètre id requis', 400, corsHeaders);
const row = await env.DB.prepare('SELECT * FROM accompagnements WHERE id = ?').bind(id).first();
if (!row) return jsonError('Compte-rendu introuvable', 404, corsHeaders);
return new Response(JSON.stringify(row), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/accompagnement-list') {
const { session, error } = await requireAccompSession(request, corsHeaders);
if (error) return error;
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const { results } = await env.DB.prepare(
'SELECT id, magasin_libelle, manager, date_visite, statut FROM accompagnements WHERE itinerant = ? ORDER BY updated_at DESC LIMIT 100'
).bind(session.nom).all();
return new Response(JSON.stringify({ ok: true, items: results || [] }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/accompagnement-finalize') {
const { session, error } = await requireAccompSession(request, corsHeaders);
if (error) return error;
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const { id } = await request.json();
if (!id) return jsonError('Paramètre id requis', 400, corsHeaders);
const row = await env.DB.prepare('SELECT * FROM accompagnements WHERE id = ?').bind(id).first();
if (!row) return jsonError('Compte-rendu introuvable', 404, corsHeaders);
if (row.statut === 'finalise') {
return new Response(JSON.stringify({ ok: true, already: true }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}
// L'envoi de l'email (avec le PDF en pièce jointe) est désormais orchestré
// côté client, comme pour Bilan de Passage (auth Zimbra fraîche, /upload,
// puis /soap avec attach.aid) — cette route ne fait plus que verrouiller
// l'enregistrement une fois l'envoi confirmé par le client.
await env.DB.prepare(
`UPDATE accompagnements SET statut='finalise', finalized_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
).bind(id).run();
return new Response(JSON.stringify({ ok: true }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/accompagnement-delete') {
const { session, error } = await requireAccompSession(request, corsHeaders);
if (error) return error;
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const { id } = await request.json();
if (!id) return jsonError('Paramètre id requis', 400, corsHeaders);
await env.DB.prepare('DELETE FROM accompagnements WHERE id = ?').bind(id).run();
return new Response(JSON.stringify({ ok: true }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/store-bilan') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) {
return new Response('Non autorisé', { status: 401, headers: corsHeaders });
}
if (!env.DB) {
return new Response('Base D1 non liée au Worker', { status: 500, headers: corsHeaders });
}
const data = await request.json();
const magasinCode = data?.magasin?.code || null;
const magasinLibelle = data?.magasin?.libelle || null;
if (!magasinCode || !data?.date) {
return new Response('Champs requis manquants (magasin.code, date)', { status: 400, headers: corsHeaders });
}
await env.DB.prepare(
`INSERT INTO bilans (magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, data_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
magasinCode,
magasinLibelle,
data.ar || null,
data.date,
data.passage || null,
data.humeur !== undefined && data.humeur !== '' ? parseInt(data.humeur) : null,
data.ca_mensuel || null,
data.ca_annuel || null,
data.renta || null,
JSON.stringify(data)
).run();
return new Response(JSON.stringify({ ok: true }), {
status: 200,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/last-actions') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const magasinCode = url.searchParams.get('magasin_code');
if (!magasinCode) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);
try {
const row = await env.DB.prepare(
'SELECT date, data_json FROM bilans WHERE magasin_code = ? ORDER BY date DESC, id DESC LIMIT 1'
).bind(magasinCode).first();
if (!row) return new Response(JSON.stringify({ ok: true, date: null, actions: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
let data = {};
try { data = JSON.parse(row.data_json); } catch(e) {}
return new Response(JSON.stringify({ ok: true, date: row.date, actions: data.actions || [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture dernier bilan : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/bilans') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

let allowedCodes = null;
if (sessionAr !== 'ALL') {
const stores = await getMagasinsServerSide();
allowedCodes = stores.filter(s => s.animateur === sessionAr).map(s => s.code);
}

const magasinCode = url.searchParams.get('magasin_code');
if (magasinCode && allowedCodes && !allowedCodes.includes(magasinCode)) {
return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
}
const from = url.searchParams.get('from');
const to = url.searchParams.get('to');
const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 1000);

let query = 'SELECT id, magasin_code, magasin_libelle, ar, date, passage, humeur, ca_mensuel, ca_annuel, renta, data_json, created_at FROM bilans WHERE 1=1';
const binds = [];
if (magasinCode) {
query += ' AND magasin_code = ?'; binds.push(magasinCode);
} else if (allowedCodes) {
if (!allowedCodes.length) return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
query += ' AND magasin_code IN (' + allowedCodes.map(() => '?').join(',') + ')';
binds.push(...allowedCodes);
}
if (from) { query += ' AND date >= ?'; binds.push(from); }
if (to) { query += ' AND date <= ?'; binds.push(to); }
query += ' ORDER BY date DESC LIMIT ?';
binds.push(limit);

const { results } = await env.DB.prepare(query).bind(...binds).all();
return new Response(JSON.stringify({ ok: true, results }), {
status: 200,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/store-health') {
// Le calcul en lui-même vit dans buildStoreHealthResults() (fichier,
// plus haut) — factorisé pour être réutilisable par le cron du digest
// hebdo (computeHealthDigest), qui n'a pas de session AR.
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const stores = await getMagasinsServerSide();
let scope = sessionAr === 'ALL' ? stores : stores.filter(s => s.animateur === sessionAr);

const magasinCode = url.searchParams.get('magasin_code');
if (magasinCode) {
scope = scope.filter(s => s.code === magasinCode);
if (!scope.length) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
}

try {
const results = await buildStoreHealthResults(env, scope);
let networkTrend = [];
if (!magasinCode && scope.length) {
// Une seule requête non filtrée (pas de IN(...) avec un paramètre par magasin —
// dépasse la limite de variables SQL de D1 dès qu'on approche la centaine de
// magasins). Filtrage et moyenne par période faits en mémoire côté JS.
const codesScope = new Set(scope.map(s => s.code));
const { results: allRows } = await env.DB.prepare(
`SELECT magasin_code, period_key, score FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
).all();
const parPeriode = {};
for (const r of allRows) {
if (!codesScope.has(r.magasin_code)) continue;
(parPeriode[r.period_key] ??= []).push(r.score);
}
networkTrend = Object.entries(parPeriode)
.map(([periode, scores]) => ({ periode, score: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10, nbMagasins: scores.length }))
.sort((a, b) => a.periode.localeCompare(b.periode))
.slice(-26);
}
return new Response(JSON.stringify({ ok: true, results, networkTrend }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur calcul fiche santé magasins : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/store-health-detail') {
// Écran détail magasin du dashboard réseau — assemble des données déjà
// calculées ailleurs (score/sous-scores, PEDLV, Kaizen, équipe, RH) sans
// dupliquer leur logique. Voir /store-health pour la vue liste équivalente.
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const code = url.searchParams.get('magasin_code');
if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);

const stores = await getMagasinsServerSide();
const store = stores.find(s => s.code === code);
if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
if (sessionAr !== 'ALL' && store.animateur !== sessionAr) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);

try {
// --- Score global + sous-scores (déjà calculés par buildStoreHealthResults) ---
const [base] = await buildStoreHealthResults(env, [store]);

// --- Historique du score (26 dernières semaines, total + 10 sous-scores) ---
const { results: historyRows } = await env.DB.prepare(
`SELECT period_key, score, score_actions, score_effectif, score_absenteisme, score_positionnement,
score_pedlv, score_avis, score_equipe, score_kaizen, score_entretiens, score_lancements
FROM store_health_score_history WHERE magasin_code = ? ORDER BY period_key ASC LIMIT 26`
).bind(code).all();
const history = historyRows.map(r => ({
periode: r.period_key, score: r.score,
sousScores: {
actions: r.score_actions, effectif: r.score_effectif, absenteisme: r.score_absenteisme,
positionnement: r.score_positionnement, pedlv: r.score_pedlv, avis: r.score_avis,
equipe: r.score_equipe, kaizen: r.score_kaizen, entretiens: r.score_entretiens, lancements: r.score_lancements,
},
}));

// --- Positionnement mensuel (Pedlv) + annuel (dernier bilan de passage) ---
const storeStatsMap = await getStoreStatsMap(env);
const statsRow = storeStatsMap[normalizeName(store.libelle)] || null;
let positionnementMensuel = null;
if (statsRow && statsRow.objectif) {
positionnementMensuel = Math.round(((statsRow.objectif - (statsRow.raf || 0)) / statsRow.objectif) * 1000) / 10;
}

// --- Pedlv détaillé : les 8 indicateurs du score santé, avec ancienneté si rouge ---
const pedlvSummary = computePedlvSummary(statsRow);
let pedlvIndicateurs = [];
if (pedlvSummary && pedlvSummary.indicateurs) {
const currentPeriod = currentWeekMonday();
const { history: pedlvHistory, periodListe } = await getPedlvIndicateursHistory(env, currentPeriod, 6);
const magasinKey = normalizeName(store.libelle);
pedlvIndicateurs = Object.entries(pedlvSummary.indicateurs).map(([key, v]) => ({
cle: key, valeur: v.valeur, objectif: v.objectif, statut: v.statut, categorie: v.categorie,
semainesRouge: v.statut === 'rouge' ? computeIndicateurStreak(pedlvHistory, periodListe, magasinKey, key) : 0,
}));
}

// --- Kaizen : points non conformes depuis plusieurs mois ---
let kaizenPointsNonResolus = [];
try {
const moisCourant = new Date().toISOString().slice(0, 7);
const zones = await getKaizenReferentiel();
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const auditRow = await env.DB.prepare(`SELECT items_json FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(code, moisCourant).first();
const itemsStateThisMonth = auditRow ? JSON.parse(auditRow.items_json || '{}') : {};
const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
kaizenPointsNonResolus = computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, code, 1);
} catch(e) { console.error('Erreur points Kaizen non résolus (détail magasin):', e); }

// --- Équipe : tâches et responsables (sans le "second", pas nécessaire ici) ---
let equipeTaches = [];
try {
const annee = anneeCouranteEval();
const { results: notes } = await env.DB.prepare(
`SELECT tache, note FROM notes_equipe WHERE magasin_code = ? AND annee = ?`
).bind(code, annee).all();
const { results: fiches } = await env.DB.prepare(
`SELECT tache, responsable FROM responsables_taches WHERE magasin_code = ?`
).bind(code).all();
const notesByTache = {};
notes.forEach(n => (notesByTache[n.tache] ??= []).push(n.note));
const tachesSet = new Set([...fiches.map(f => f.tache), ...notes.map(n => n.tache)]);
equipeTaches = [...tachesSet].map(tache => {
const noteList = (notesByTache[tache] || []).sort((a, b) => b - a).slice(0, 3);
const moyenne = noteList.length ? Math.round((noteList.reduce((s, n) => s + n, 0) / noteList.length) * 10) / 10 : null;
const fiche = fiches.find(f => f.tache === tache);
return { tache, responsable: fiche ? fiche.responsable : null, moyenne };
});
} catch(e) { console.error('Erreur tâches équipe (détail magasin):', e); }

// --- Manager du magasin (colonne manager de magasins.csv, plus simple et plus fiable que l'import RH) ---
const manager = store.manager || null;

// --- CA prévisionnel annuel = objectif annuel (magasins.csv, en k€) × positionnement annuel (%) ---
const caPrevisionnelAnnuel = (store.objectifAnnuel !== null && base.positionnementAnnuel !== null && base.positionnementAnnuel !== undefined)
? Math.round(store.objectifAnnuel * base.positionnementAnnuel) / 100
: null;

return new Response(JSON.stringify({
ok: true,
magasin: { code: store.code, libelle: store.libelle, animateur: store.animateur, concept: store.concept },
...base,
positionnementMensuel,
objectifAnnuel: store.objectifAnnuel,
caPrevisionnelAnnuel,
history,
pedlvIndicateurs,
kaizenPointsNonResolus,
equipeTaches,
manager,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur détail magasin : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/store-advice' && request.method === 'POST') {
// Conseils d'action IA pour la fiche détail magasin du dashboard — reprend
// exactement les données déjà assemblées pour /store-health-detail (recalculées
// ici côté serveur, jamais reçues du client, pour ne jamais faire confiance à
// des données qu'on pourrait manipuler avant de les envoyer à l'IA).
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (!env.ANTHROPIC_API_KEY) return jsonError('Clé API Anthropic non configurée sur le Worker', 500, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const body = await request.json().catch(() => ({}));
const code = body.magasin_code;
if (!code) return jsonError('Paramètre magasin_code requis', 400, corsHeaders);

const stores = await getMagasinsServerSide();
const store = stores.find(s => s.code === code);
if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);
if (sessionAr !== 'ALL' && store.animateur !== sessionAr) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);

try {
const [base] = await buildStoreHealthResults(env, [store]);
const storeStatsMap = await getStoreStatsMap(env);
const statsRow = storeStatsMap[normalizeName(store.libelle)] || null;
const pedlvSummary = computePedlvSummary(statsRow);
const pedlvRouges = pedlvSummary && pedlvSummary.indicateurs
? Object.entries(pedlvSummary.indicateurs).filter(([, v]) => v.statut === 'rouge').map(([k, v]) => `${k} (valeur ${v.valeur}, objectif ${v.objectif})`)
: [];

const moisCourant = new Date().toISOString().slice(0, 7);
const zones = await getKaizenReferentiel();
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const auditRow = await env.DB.prepare(`SELECT items_json FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(code, moisCourant).first();
const itemsStateThisMonth = auditRow ? JSON.parse(auditRow.items_json || '{}') : {};
const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
const kaizenPointsNonResolus = computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, code, 1);

const actionsNonSoldees = (base.actionsNonSoldees && base.actionsNonSoldees.items || []).filter(a => a.fromPrevious);

const lignes = [
`Magasin : ${store.libelle} (${store.code}), animateur ${store.animateur || 'non renseigné'}.`,
`Score de santé global : ${base.score !== null ? base.score + '/100' : 'pas assez de données'}.`,
`Dernière visite : ${base.lastVisitDate ? base.lastVisitDate + ' (' + base.daysSinceVisit + ' jours)' : 'jamais'}.`,
`Sous-scores : ${Object.entries(base.subScores || {}).map(([k, v]) => `${k}=${v !== null ? Math.round(v) : 'N/A'}`).join(', ')}.`,
actionsNonSoldees.length ? `Actions de bilan de passage non soldées depuis plusieurs visites : ${actionsNonSoldees.map(a => a.text).join(' ; ')}.` : `Aucune action de bilan de passage en retard.`,
kaizenPointsNonResolus.length ? `Points Kaizen non conformes depuis plusieurs mois : ${kaizenPointsNonResolus.map(k => k.label + (k.zoneNom ? ' (' + k.zoneNom + ')' : '')).join(' ; ')}.` : `Pas de point Kaizen non résolu.`,
pedlvRouges.length ? `Indicateurs Pedlv actuellement dans le rouge : ${pedlvRouges.join(' ; ')}.` : `Aucun indicateur Pedlv dans le rouge.`,
`Effectif vs théorique : ${base.effectif ? base.effectif.label : 'pas de donnée'}${base.effectifRH && base.effectifRH.soutenu ? ' (sous-effectif soutenu depuis 3 mois)' : ''}.`,
base.niveauEquipe !== null && base.niveauEquipe !== undefined ? `Note équipe (évaluation équipe) : ${base.niveauEquipe}/10.` : `Pas de donnée d'évaluation équipe.`,
];

const systemPrompt = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à préparer sa prochaine visite dans un magasin précis. On te donne un état des lieux structuré du magasin (score de santé, actions en retard, points Kaizen non résolus, indicateurs commerciaux Pedlv en alerte, effectif, équipe). Produis une liste courte de 3 à 5 actions concrètes et priorisées à mener sur ce point de vente, en commençant par la plus urgente. Reste factuel, base-toi uniquement sur les données fournies (n'invente rien), sois direct et actionnable — pas de généralités. Format : liste à puces, une action par ligne.`;

const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({
model: 'claude-sonnet-5', max_tokens: 800, thinking: { type: 'disabled' },
system: systemPrompt,
messages: [{ role: 'user', content: lignes.join('\n') }],
}),
});
const claudeData = await claudeResp.json();
if (!claudeResp.ok) return jsonError('Erreur API Claude : ' + JSON.stringify(claudeData), 500, corsHeaders);
const texte = (claudeData.content || []).map(b => b.text || '').join('\n').trim();

return new Response(JSON.stringify({ ok: true, conseils: texte }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération conseils : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/ar-dashboard') {
// "Mon dashboard" — équivalent de la fiche magasin, mais agrégé sur tout le
// périmètre d'un animateur. Réutilise buildStoreHealthResults (comme
// /store-health) et la même logique de continuité Kaizen que
// /store-health-detail, appliquée à chaque magasin du périmètre.
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const arName = url.searchParams.get('ar');
if (!arName) return jsonError('Paramètre ar requis', 400, corsHeaders);
if (sessionAr !== 'ALL' && sessionAr !== arName) return jsonError('Périmètre hors de votre accès', 403, corsHeaders);

const allStores = await getMagasinsServerSide();
const scope = allStores.filter(s => s.animateur === arName);
if (!scope.length) return jsonError('Aucun magasin trouvé pour cet animateur', 404, corsHeaders);

try {
const results = await buildStoreHealthResults(env, scope);
// results est trié par ancienneté de visite (voir buildStoreHealthResults) —
// jamais dans le même ordre que scope. Tout appariement magasin par magasin
// doit passer par le code, jamais par la position dans le tableau (bug latent
// corrigé le 06/09, touchait déjà caPrevisionnelTotal avant les pondérations).
const scopeByCode = new Map(scope.map(s => [s.code, s]));

// --- Historique moyen (mêmes colonnes que /store-health-detail, moyennées sur le périmètre) ---
const codesScope = new Set(scope.map(s => s.code));
const { results: allRows } = await env.DB.prepare(
`SELECT magasin_code, period_key, score, score_actions, score_effectif, score_absenteisme, score_positionnement,
score_pedlv, score_avis, score_equipe, score_kaizen, score_entretiens, score_lancements
FROM store_health_score_history WHERE score IS NOT NULL ORDER BY period_key ASC`
).all();
const parPeriode = {};
for (const r of allRows) {
if (!codesScope.has(r.magasin_code)) continue;
(parPeriode[r.period_key] ??= []).push(r);
}
const avgOf = (rows, key) => {
const vals = rows.map(r => r[key]).filter(v => v !== null && v !== undefined);
return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
};
const history = Object.entries(parPeriode).map(([periode, rows]) => ({
periode, score: avgOf(rows, 'score'),
sousScores: {
actions: avgOf(rows, 'score_actions'), effectif: avgOf(rows, 'score_effectif'), absenteisme: avgOf(rows, 'score_absenteisme'),
positionnement: avgOf(rows, 'score_positionnement'), pedlv: avgOf(rows, 'score_pedlv'), avis: avgOf(rows, 'score_avis'),
equipe: avgOf(rows, 'score_equipe'), kaizen: avgOf(rows, 'score_kaizen'),
entretiens: avgOf(rows, 'score_entretiens'), lancements: avgOf(rows, 'score_lancements'),
},
})).sort((a, b) => a.periode.localeCompare(b.periode)).slice(-26);

// --- Agrégats simples ---
const moyenneListe = vals => { const v = vals.filter(x => x !== null && x !== undefined); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
// Moyenne pondérée : pairs = [[valeur, poids], ...]. Utilisée partout où une
// moyenne simple entre magasins de tailles très différentes serait trompeuse
// (ex. taux d'absentéisme 1 personne/4 vs 1/8 : signalé par Olivier le 06/09).
const moyennePonderee = pairs => {
const valides = pairs.filter(([v, p]) => v !== null && v !== undefined && p !== null && p !== undefined && p > 0);
const totalPoids = valides.reduce((s, [, p]) => s + p, 0);
if (!totalPoids) return null;
return Math.round((valides.reduce((s, [v, p]) => s + v * p, 0) / totalPoids) * 10) / 10;
};
const scoreMoyen = moyenneListe(results.map(r => r.score));
// Positionnement pondéré par l'objectif annuel : un magasin à 2000k€ d'objectif
// pèse plus dans la moyenne qu'un magasin à 500k€, plutôt que de compter pareil.
const positionnementAnnuelMoyen = moyennePonderee(results.map(r => [r.positionnementAnnuel, (scopeByCode.get(r.code) || {}).objectifAnnuel]));
const objectifAnnuelTotal = scope.reduce((sum, s) => sum + (s.objectifAnnuel || 0), 0);
const caPrevisionnelTotal = Math.round(results.reduce((sum, r) => {
const store = scopeByCode.get(r.code);
if (store && store.objectifAnnuel !== null && r.positionnementAnnuel !== null && r.positionnementAnnuel !== undefined) {
return sum + (store.objectifAnnuel * r.positionnementAnnuel) / 100;
}
return sum;
}, 0));
const subKeys = ['actions', 'effectif', 'absenteisme', 'positionnement', 'pedlv', 'avis', 'equipe', 'kaizen'];
const subScoresMoyens = {};
for (const k of subKeys) subScoresMoyens[k] = moyenneListe(results.map(r => r.subScores ? r.subScores[k] : null));

// --- Actions non soldées agrégées (toutes stores confondus, avec le nom du magasin) ---
const actionsAgregees = [];
for (const r of results) {
(r.actionsNonSoldees && r.actionsNonSoldees.items || []).filter(a => a.fromPrevious).forEach(a =>
actionsAgregees.push({ magasin: r.libelle, text: a.text, repriseCount: a.repriseCount })
);
}

// --- Points Kaizen non résolus agrégés (une passe par magasin du périmètre) ---
const kaizenAgreges = [];
try {
const moisCourant = new Date().toISOString().slice(0, 7);
const zones = await getKaizenReferentiel();
const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
for (const store of scope) {
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const auditRow = await env.DB.prepare(`SELECT items_json FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(store.code, moisCourant).first();
const itemsStateThisMonth = auditRow ? JSON.parse(auditRow.items_json || '{}') : {};
const pts = computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, store.code, 1);
pts.forEach(p => kaizenAgreges.push({ magasin: store.libelle, ...p }));
}
} catch (e) { console.error('Erreur points Kaizen agrégés (dashboard AR):', e); }

// --- Pedlv agrégé : les 8 indicateurs, moyenne PONDÉRÉE par le vrai volume du
// magasin — nb_vente_opt (ligne TOTAL du fichier Cosium) côté optique,
// protheses_vendues côté audio. Les deux sont déjà envoyés par PEDLV, aucune
// estimation nécessaire (suggestion d'Olivier, 06/09).
const storeStatsMap = await getStoreStatsMap(env);
const pedlvAgregatData = {};
for (const store of scope) {
const statsRow = storeStatsMap[normalizeName(store.libelle)] || null;
const summary = computePedlvSummary(statsRow);
if (!summary || !summary.indicateurs) continue;
for (const [key, v] of Object.entries(summary.indicateurs)) {
if (!pedlvAgregatData[key]) pedlvAgregatData[key] = { valeursPonderees: [], objectifs: [], nbRouge: 0, nbTotal: 0 };
const acc = pedlvAgregatData[key];
const poids = v.categorie === 'audio' ? (statsRow && statsRow.protheses_vendues) : (statsRow && statsRow.nb_vente_opt);
if (v.valeur !== null && v.valeur !== undefined) acc.valeursPonderees.push([v.valeur, poids ?? 1]);
if (v.objectif !== null && v.objectif !== undefined) acc.objectifs.push(v.objectif);
acc.nbTotal++;
if (v.statut === 'rouge') acc.nbRouge++;
}
}
const modeListe = vals => {
const v = vals.filter(x => x !== null && x !== undefined);
if (!v.length) return null;
const compte = new Map();
for (const x of v) compte.set(x, (compte.get(x) || 0) + 1);
let meilleur = v[0], meilleurCompte = 0;
for (const [val, c] of compte) if (c > meilleurCompte) { meilleur = val; meilleurCompte = c; }
return meilleur;
};
const pedlvIndicateursAgreges = Object.entries(pedlvAgregatData).map(([cle, acc]) => ({
cle, valeurMoyenne: moyennePonderee(acc.valeursPonderees), objectifMoyen: modeListe(acc.objectifs), nbRouge: acc.nbRouge, nbTotal: acc.nbTotal,
}));

// --- Équipe agrégée : note moyenne du secteur + moyenne par tâche + tâches vacantes ---
const niveauEquipeMoyen = moyennePonderee(results.map(r => [
r.niveauEquipe !== null && r.niveauEquipe !== undefined ? Number(r.niveauEquipe) : null,
(scopeByCode.get(r.code) || {}).effTheo,
]));
let equipeTachesAgregees = [];
try {
const annee = anneeCouranteEval();
const codes = scope.map(s => s.code);
const placeholders = codes.map(() => '?').join(',');
const { results: notes } = await env.DB.prepare(`SELECT magasin_code, tache, note FROM notes_equipe WHERE magasin_code IN (${placeholders}) AND annee = ?`).bind(...codes, annee).all();
const { results: fiches } = await env.DB.prepare(`SELECT magasin_code, tache, responsable FROM responsables_taches WHERE magasin_code IN (${placeholders})`).bind(...codes).all();
const notesByTache = {};
notes.forEach(n => { (notesByTache[n.tache] ??= {}); (notesByTache[n.tache][n.magasin_code] ??= []).push(n.note); });
const fichesByTache = {};
fiches.forEach(f => { (fichesByTache[f.tache] ??= {})[f.magasin_code] = f.responsable; });
const tachesSet = new Set([...notes.map(n => n.tache), ...fiches.map(f => f.tache)]);
equipeTachesAgregees = [...tachesSet].map(tache => {
const parMagasin = notesByTache[tache] || {};
const moyennesParMagasin = Object.values(parMagasin).map(noteList => {
const top3 = noteList.slice().sort((a, b) => b - a).slice(0, 3);
return top3.reduce((a, b) => a + b, 0) / top3.length;
});
const respMap = fichesByTache[tache] || {};
const magasinsVacants = scope.filter(s => !respMap[s.code]).map(s => s.libelle);
return { tache, moyenne: moyenneListe(moyennesParMagasin), nbVacant: magasinsVacants.length, nbTotal: scope.length, magasinsVacants };
});
} catch (e) { console.error('Erreur tâches équipe agrégées (dashboard AR):', e); }

// --- Effectif agrégé : magasins en sous-effectif soutenu + en sur-effectif ---
const sousEffectifSoutenu = results.filter(r => r.effectifRH && r.effectifRH.soutenu).map(r => r.libelle);
const sureffectif = results.filter(r => r.effectif && r.effectif.delta !== null && r.effectif.delta !== undefined && r.effectif.delta > 0).map(r => r.libelle);

// --- Taux d'absentéisme du secteur, VRAIMENT pondéré ---
// Piège signalé par Olivier (06/09) : moyenner les notes déjà calculées par
// magasin traite un magasin de 4 personnes comme un magasin de 20 — 1 absent
// sur 4 (25%) pèserait alors autant que 1 absent sur 20 (5%). Correction :
// on repart des jours-personnes bruts (même requête que getRhHealthSignalsMap),
// on les additionne sur tout le secteur POUR CHAQUE MOIS d'abord, puis on
// calcule un taux mensuel du secteur — la pondération se fait donc au niveau
// des personnes, pas des magasins.
let tauxAbsenteismeMoyen = null;
try {
const codesAbsScope = scope.map(s => s.code);
const placeholdersAbs = codesAbsScope.map(() => '?').join(',');
const { results: absRows } = await env.DB.prepare(`
SELECT es.mois as mois, SUM(a.jours_groupe_a * es.poids) as groupe_a_pondere, SUM(a.jours_ouvres_theoriques * es.poids) as theo_pondere
FROM rh_effectif_site_mensuel es
JOIN rh_agenda_mensuel a ON a.mois = es.mois AND a.matricule = es.matricule
WHERE es.site_reconnu = 1 AND es.code_site IN (${placeholdersAbs})
GROUP BY es.mois ORDER BY es.mois ASC
`).bind(...codesAbsScope).all();
const notesMensuelles = absRows
.filter(r => r.theo_pondere > 0)
.map(r => Math.max(0, 100 - (r.groupe_a_pondere / r.theo_pondere) * 100));
if (notesMensuelles.length) {
const noteMoyenne = notesMensuelles.reduce((a, b) => a + b, 0) / notesMensuelles.length;
tauxAbsenteismeMoyen = Math.round((100 - noteMoyenne) * 10) / 10;
}
} catch (e) { console.error('Erreur taux absentéisme pondéré (dashboard AR):', e); }

return new Response(JSON.stringify({
ok: true, ar: arName, nbMagasins: scope.length,
scoreMoyen, positionnementAnnuelMoyen, objectifAnnuelTotal, caPrevisionnelTotal,
subScoresMoyens, history, results, actionsAgregees, kaizenAgreges,
pedlvIndicateursAgreges, niveauEquipeMoyen, equipeTachesAgregees, sousEffectifSoutenu, sureffectif, tauxAbsenteismeMoyen,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur dashboard animateur : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/ar-advice' && request.method === 'POST') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (!env.ANTHROPIC_API_KEY) return jsonError('Clé API Anthropic non configurée sur le Worker', 500, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const body = await request.json().catch(() => ({}));
const arName = body.ar;
if (!arName) return jsonError('Paramètre ar requis', 400, corsHeaders);
if (sessionAr !== 'ALL' && sessionAr !== arName) return jsonError('Périmètre hors de votre accès', 403, corsHeaders);

const allStores = await getMagasinsServerSide();
const scope = allStores.filter(s => s.animateur === arName);
if (!scope.length) return jsonError('Aucun magasin trouvé pour cet animateur', 404, corsHeaders);

try {
const results = await buildStoreHealthResults(env, scope);
const moisCourant = new Date().toISOString().slice(0, 7);
const zones = await getKaizenReferentiel();
const { history: kzHistory, moisListe } = await getKaizenItemsHistory(env, moisCourant, 6);
const kaizenAgreges = [];
for (const store of scope) {
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const auditRow = await env.DB.prepare(`SELECT items_json FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`).bind(store.code, moisCourant).first();
const itemsStateThisMonth = auditRow ? JSON.parse(auditRow.items_json || '{}') : {};
computeStuckKaizenItems(itemsStateThisMonth, itemsApplicables, kzHistory, moisListe, store.code, 1)
.forEach(p => kaizenAgreges.push(`${store.libelle} : ${p.label}${p.zoneNom ? ' (' + p.zoneNom + ')' : ''} — ${p.moisConsecutifs} mois`));
}
const actionsAgregees = [];
for (const r of results) {
(r.actionsNonSoldees && r.actionsNonSoldees.items || []).filter(a => a.fromPrevious).forEach(a =>
actionsAgregees.push(`${r.libelle} : ${a.text} (${a.repriseCount + 1} visites)`)
);
}
const magasinsEnAlerte = results.filter(r => r.score !== null && r.score < HEALTH_LOW_SCORE_THRESHOLD).map(r => `${r.libelle} (score ${r.score})`);

const lignes = [
`Périmètre de l'animateur réseau ${arName} : ${scope.length} magasins.`,
magasinsEnAlerte.length ? `Magasins en alerte (score bas) : ${magasinsEnAlerte.join(' ; ')}.` : `Aucun magasin en alerte sur le score global.`,
actionsAgregees.length ? `Actions de bilan de passage non soldées depuis plusieurs visites : ${actionsAgregees.join(' ; ')}.` : `Aucune action de bilan de passage en retard sur le périmètre.`,
kaizenAgreges.length ? `Points Kaizen non conformes depuis plusieurs mois : ${kaizenAgreges.join(' ; ')}.` : `Pas de point Kaizen non résolu sur le périmètre.`,
];

const systemPrompt = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à prioriser sa semaine sur l'ensemble de son périmètre de magasins. On te donne un état des lieux structuré (magasins en alerte, actions en retard, points Kaizen non résolus). Produis une liste courte de 3 à 5 priorités concrètes pour la semaine, en commençant par la plus urgente, en précisant le magasin concerné pour chaque priorité. Reste factuel, base-toi uniquement sur les données fournies (n'invente rien), sois direct et actionnable.`;

const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
body: JSON.stringify({
model: 'claude-sonnet-5', max_tokens: 900, thinking: { type: 'disabled' },
system: systemPrompt,
messages: [{ role: 'user', content: lignes.join('\n') }],
}),
});
const claudeData = await claudeResp.json();
if (!claudeResp.ok) return jsonError('Erreur API Claude : ' + JSON.stringify(claudeData), 500, corsHeaders);
const texte = (claudeData.content || []).map(b => b.text || '').join('\n').trim();

return new Response(JSON.stringify({ ok: true, conseils: texte }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération conseils AR : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/analyze') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) {
return new Response(JSON.stringify({ error: 'Non autorisé' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (!env.ANTHROPIC_API_KEY) {
return new Response(JSON.stringify({ error: 'Clé API Anthropic non configurée sur le Worker (secret ANTHROPIC_API_KEY manquant ou non déployé)' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
const { mode, bilans } = await request.json();
if (!Array.isArray(bilans) || !bilans.length) {
return new Response(JSON.stringify({ error: 'Aucune donnée à analyser' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}

let systemPrompt, userContent;
if (mode === 'group') {
systemPrompt = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à préparer sa tournée terrain. On te donne l'historique récent de plusieurs magasins. Pour chaque magasin, produis une synthèse courte et actionnable : tendance générale, actions non résolues qui traînent, et 1 à 2 points de vigilance prioritaires. Reste factuel, base-toi uniquement sur les données fournies, sois concis (pas de blabla). Structure ta réponse par magasin avec un titre clair.`;
userContent = bilans.map((storeBilans, i) =>
`=== Magasin ${i + 1} ===\n` + storeBilans.map(resumeBilan).join('\n\n---\n\n')
).join('\n\n\n');
} else {
systemPrompt = `Tu es un assistant qui aide un animateur réseau (AR) d'Optical Center à analyser l'historique d'un magasin. On te donne les bilans de passage successifs. Identifie les tendances (amélioration/dégradation), les actions récurrentes qui ne sont jamais résolues, et les points d'alerte. Reste factuel, base-toi uniquement sur les données fournies, sois concis et actionnable.`;
userContent = bilans.map(resumeBilan).join('\n\n---\n\n');
}

const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'x-api-key': env.ANTHROPIC_API_KEY,
'anthropic-version': '2023-06-01',
},
body: JSON.stringify({
model: 'claude-sonnet-5',
max_tokens: 1500,
thinking: { type: 'disabled' },
system: systemPrompt,
messages: [{ role: 'user', content: userContent }],
}),
});
const claudeData = await claudeResp.json();
if (!claudeResp.ok) {
return new Response(JSON.stringify({ error: claudeData }), {
status: claudeResp.status,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}
const analysis = (claudeData.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
await logAnalyzeCall(env, {
ar: sessionAr,
mode: mode || 'single',
nbMagasins: mode === 'group' ? bilans.length : 1,
inputTokens: claudeData.usage ? claudeData.usage.input_tokens : null,
outputTokens: claudeData.usage ? claudeData.usage.output_tokens : null,
});
return new Response(JSON.stringify({ ok: true, analysis }), {
status: 200,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/store-stats') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const s = await request.json();
if (!s.magasin) return jsonError('Champ magasin requis', 400, corsHeaders);
await env.DB.prepare(
`INSERT INTO store_stats (magasin, code_magasin, periode, date_extraction, ca_total, ca_opt, ca_audio, panier_moyen, taux_tc, taux_sop, taux_mdc, protheses_vendues, taux_essai, objectif, raf, prios_json, taux_test_auditif, taux_vente_add_audio, taux_pack_confort, pm_pack_confort, indicateurs_json, nb_vente_opt, jours_ouvres_mois)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(
s.magasin, s.codeMagasin || null, s.periode || null, s.dateExtraction || null,
s.caTotal ?? null, s.caOpt ?? null, s.caAudio ?? null, s.panierMoyen ?? null,
s.tauxTc ?? null, s.tauxSop ?? null, s.tauxMdc ?? null,
s.prothesesVendues ?? null, s.tauxEssai ?? null, s.objectif ?? null, s.raf ?? null,
JSON.stringify(s.prios || []),
s.tauxTestAuditif ?? null, s.tauxVenteAddAudio ?? null,
s.tauxPackConfort ?? null, s.pmPackConfort ?? null,
JSON.stringify(s.indicateurs || {}), s.nbVenteOpt ?? null, s.joursOuvresMois ?? null
).run();

try {
const periodKey = currentWeekMonday();
const aliasResolution = await getStoreStatsAliasResolution(env);
const stores = await getMagasinsServerSide();
const storesByCode = new Map(stores.map(st => [st.code, st]));
const magasinKey = resolveStoreStatsKey({ magasin: s.magasin, code_magasin: s.codeMagasin }, aliasResolution, storesByCode);
const { rouge, total } = summarizePedlvIndicateurs(s.indicateurs);
await env.DB.prepare(
`INSERT INTO store_stats_history (magasin, magasin_key, period_key, ca_total, objectif, raf, panier_moyen, pedlv_rouge, pedlv_total, indicateurs_json, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(magasin_key, period_key) DO UPDATE SET
magasin = excluded.magasin, ca_total = excluded.ca_total, objectif = excluded.objectif,
raf = excluded.raf, panier_moyen = excluded.panier_moyen, pedlv_rouge = excluded.pedlv_rouge,
pedlv_total = excluded.pedlv_total, indicateurs_json = excluded.indicateurs_json, updated_at = excluded.updated_at`
).bind(
s.magasin, magasinKey, periodKey,
s.caTotal ?? null, s.objectif ?? null, s.raf ?? null, s.panierMoyen ?? null,
rouge, total, JSON.stringify(s.indicateurs || {}), new Date().toISOString()
).run();
} catch(e) { console.error('Erreur maj store_stats_history:', e); }

return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur enregistrement : ' + String(e), 500, corsHeaders);
}
}

// ---------- Indicateur RH — import mensuel (19/08) ----------

if (url.pathname === '/rh-import/effectif') {
  const storeToken = request.headers.get('X-Store-Token');
  if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
  if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
  const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
  if (sessionAr !== 'ALL') return jsonError('Réservé à Olivier', 403, corsHeaders);

  try {
    const body = await request.json();
    const mois = (body.mois || '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!/^\d{4}-\d{2}$/.test(mois)) return jsonError('Champ "mois" requis, format YYYY-MM', 400, corsHeaders);
    if (!rows.length) return jsonError('Aucune ligne à importer', 400, corsHeaders);

    const stores = await getMagasinsServerSide();
    const magasinsCodes = new Set(stores.map(s => s.code));

    const now = new Date().toISOString();
    const sitesNonReconnus = new Map();
    let nbSalaries = 0, nbSansSite = 0;
    const stmts = [];

    for (const row of rows) {
      const matricule = String(row['Matricule'] ?? '').trim();
      if (!matricule) continue;
      nbSalaries++;

      const poste = String(row['Poste'] ?? '').trim();
      const posteCategorie = rhMapPosteCategorie(poste);
      const codesSitesRaw = String(row['Codes sites'] ?? '').trim();
      const nomsSitesRaw = String(row['Noms sites'] ?? '').trim();
      const codesSites = codesSitesRaw ? codesSitesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
      const nomsSites = nomsSitesRaw ? nomsSitesRaw.split(',').map(s => s.trim()) : [];
      const nbSites = codesSites.length;
      if (!nbSites) nbSansSite++;

      stmts.push(env.DB.prepare(
        `INSERT INTO rh_effectif_mensuel (mois, matricule, nom, prenom, genre, poste, poste_categorie, codes_sites, nb_sites, date_entree, date_depart, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mois, matricule) DO UPDATE SET
           nom=excluded.nom, prenom=excluded.prenom, genre=excluded.genre, poste=excluded.poste,
           poste_categorie=excluded.poste_categorie, codes_sites=excluded.codes_sites, nb_sites=excluded.nb_sites,
           date_entree=excluded.date_entree, date_depart=excluded.date_depart, created_at=excluded.created_at`
      ).bind(
        mois, matricule,
        String(row['Nom'] ?? '').trim() || null, String(row['Prénom'] ?? '').trim() || null,
        String(row['Genre'] ?? '').trim() || null, poste || null, posteCategorie,
        codesSitesRaw || null, nbSites,
        String(row["Date d'entrée"] ?? '').trim() || null, String(row['Date de départ'] ?? '').trim() || null,
        now
      ));

      // Idempotent : on repart de zéro sur la répartition par site de ce salarié pour ce mois avant réinsertion.
      stmts.push(env.DB.prepare(`DELETE FROM rh_effectif_site_mensuel WHERE mois = ? AND matricule = ?`).bind(mois, matricule));

      codesSites.forEach((codeRh, i) => {
        const { code, reconnu } = rhMapCodeSiteVersMagasin(codeRh, magasinsCodes);
        const codeFinal = code || codeRh;
        if (!reconnu) sitesNonReconnus.set(codeFinal, nomsSites[i] || '');
        stmts.push(env.DB.prepare(
          `INSERT INTO rh_effectif_site_mensuel (mois, matricule, code_site, site_reconnu, poste_categorie, poids)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(mois, matricule, codeFinal, reconnu ? 1 : 0, posteCategorie, 1 / nbSites));
      });
    }

    for (let i = 0; i < stmts.length; i += 400) {
      await env.DB.batch(stmts.slice(i, i + 400));
    }

    return new Response(JSON.stringify({
      ok: true, mois, nbSalaries, nbSansSite,
      sitesNonReconnus: [...sitesNonReconnus.entries()].map(([code, nom]) => ({ code, nom })),
    }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  } catch (e) {
    return jsonError('Erreur import effectif : ' + String(e), 500, corsHeaders);
  }
}

if (url.pathname === '/rh-import/agenda') {
  const storeToken = request.headers.get('X-Store-Token');
  if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
  if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
  const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
  if (sessionAr !== 'ALL') return jsonError('Réservé à Olivier', 403, corsHeaders);

  try {
    const body = await request.json();
    const mois = (body.mois || '').trim();
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!/^\d{4}-\d{2}$/.test(mois)) return jsonError('Champ "mois" requis, format YYYY-MM', 400, corsHeaders);
    if (!rows.length) return jsonError('Aucune ligne à importer', 400, corsHeaders);

    const joursCalendaires = rhJoursDansMois(mois);
    const moisPrecedent = rhMoisPrecedent(mois);
    const { results: prevRows } = await env.DB.prepare(
      `SELECT matricule, maladie_at_jours FROM rh_agenda_mensuel WHERE mois = ?`
    ).bind(moisPrecedent).all();
    const maladieAtMoisPrecedent = new Map(prevRows.map(r => [r.matricule, r.maladie_at_jours || 0]));

    const now = new Date().toISOString();
    const stmts = [];
    let nbSalaries = 0, nbLongueDuree = 0;

    for (const row of rows) {
      const matricule = String(row['Matricule'] ?? '').trim();
      if (!matricule) continue;
      nbSalaries++;

      const joursGroupeA = rhSommeColonnes(row, RH_GROUPE_A_COLS);
      const joursGroupeB = rhSommeColonnes(row, RH_GROUPE_B_COLS);
      const maladieAtJours = rhSommeColonnes(row, RH_MALADIE_AT_COLS);
      const maternitéParentalJours = rhSommeColonnes(row, RH_MATERNITE_PARENTAL_COLS);
      const reposHebdo = rhNum(row['Repos hebdomadaire']);
      const feries = rhNum(row['Férié']);
      const fermeture = rhNum(row['Jour de fermeture']);
      const joursOuvresTheoriques = joursCalendaires - reposHebdo - feries - fermeture;

      let longueDuree = 0;
      if (maternitéParentalJours > 0) {
        longueDuree = 1;
      } else if (maladieAtJours > 0 && (maladieAtMoisPrecedent.get(matricule) || 0) > 0) {
        longueDuree = 1;
      }
      if (longueDuree) nbLongueDuree++;

      stmts.push(env.DB.prepare(
        `INSERT INTO rh_agenda_mensuel (mois, matricule, type_contrat, jours_groupe_a, jours_groupe_b, jours_calendaires, jours_repos_hebdo, jours_feries, jours_fermeture_magasin, jours_ouvres_theoriques, maladie_at_jours, longue_duree, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mois, matricule) DO UPDATE SET
           type_contrat=excluded.type_contrat, jours_groupe_a=excluded.jours_groupe_a, jours_groupe_b=excluded.jours_groupe_b,
           jours_calendaires=excluded.jours_calendaires, jours_repos_hebdo=excluded.jours_repos_hebdo, jours_feries=excluded.jours_feries,
           jours_fermeture_magasin=excluded.jours_fermeture_magasin, jours_ouvres_theoriques=excluded.jours_ouvres_theoriques,
           maladie_at_jours=excluded.maladie_at_jours, longue_duree=excluded.longue_duree, created_at=excluded.created_at`
      ).bind(
        mois, matricule, String(row['Type contrat'] ?? '').trim() || null,
        joursGroupeA, joursGroupeB, joursCalendaires, reposHebdo, feries, fermeture, joursOuvresTheoriques,
        maladieAtJours, longueDuree, now
      ));
    }

    for (let i = 0; i < stmts.length; i += 400) {
      await env.DB.batch(stmts.slice(i, i + 400));
    }

    return new Response(JSON.stringify({ ok: true, mois, nbSalaries, nbLongueDuree }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e) {
    return jsonError('Erreur import agenda : ' + String(e), 500, corsHeaders);
  }
}

// Route de lecture — effectif réel par magasin (dernier mois chargé), pour
// pré-remplir Bilan de Passage et Pour être dans le vert (phase 3, 20/08).
if (url.pathname === '/rh-effectif') {
  const storeToken = request.headers.get('X-Store-Token');
  if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
  if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

  try {
    const magasinCode = url.searchParams.get('magasin_code');
    // Pour être dans le vert n'a pas de code magasin fiable (son "Code Magasin"
    // vient d'un système de caisse distinct, jamais garanti aligné sur
    // magasins.csv) — seulement des libellés. `noms` permet de résoudre
    // côté serveur par nom, avec la même logique normalizeName() + table
    // d'alias déjà utilisée et validée pour store_stats, plutôt que de
    // dupliquer une correspondance approximative côté client.
    const nomsRaw = url.searchParams.get('noms');
    // Le mois le plus récent est désormais calculé PAR MAGASIN quand un code
    // magasin précis est demandé (Bilan de Passage) — sinon un magasin dont
    // l'import RH accuse un mois de retard par rapport au reste du réseau
    // perdait silencieusement son pré-remplissage dès qu'un autre magasin
    // avançait au mois suivant (même bug racine que /rh-collaborateurs,
    // découvert le 17/09 sur Fresnes). En mode réseau (noms, PEDLV), le
    // comportement reste global pour l'instant — non concerné par ce bug.
    const row = magasinCode
      ? await env.DB.prepare(
          `SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel WHERE code_site = ? AND site_reconnu = 1`
        ).bind(magasinCode).first()
      : await env.DB.prepare(`SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel`).first();
    const dernierMois = row && row.mois;
    if (!dernierMois) {
      return new Response(JSON.stringify({ ok: true, mois: null, magasins: {} }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    let query = `SELECT code_site, poste_categorie, SUM(poids) as total
                 FROM rh_effectif_site_mensuel
                 WHERE mois = ? AND site_reconnu = 1 AND poste_categorie IS NOT NULL`;
    const binds = [dernierMois];
    if (magasinCode) { query += ' AND code_site = ?'; binds.push(magasinCode); }
    query += ' GROUP BY code_site, poste_categorie';

    const { results } = await env.DB.prepare(query).bind(...binds).all();
    const magasins = {};
    for (const r of results) {
      if (!magasins[r.code_site]) magasins[r.code_site] = { eff_opt: 0, eff_audio: 0 };
      const val = Math.round(r.total * 10) / 10;
      if (r.poste_categorie === 'opticien') magasins[r.code_site].eff_opt = val;
      if (r.poste_categorie === 'audio') magasins[r.code_site].eff_audio = val;
    }

    if (nomsRaw) {
      const stores = await getMagasinsServerSide();
      const aliasResolution = await getStoreStatsAliasResolution(env);
      const noms = nomsRaw.split(',').map(s => s.trim()).filter(Boolean);
      const parNom = {};
      for (const nom of noms) {
        const rawKey = normalizeName(nom);
        const key = aliasResolution[rawKey] || rawKey;
        const store = stores.find(s => normalizeName(s.libelle) === key);
        if (store && magasins[store.code]) parNom[nom] = magasins[store.code];
      }
      return new Response(JSON.stringify({ ok: true, mois: dernierMois, magasins: parNom }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response(JSON.stringify({ ok: true, mois: dernierMois, magasins }), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  } catch (e) {
    return jsonError('Erreur lecture effectif : ' + String(e), 500, corsHeaders);
  }
}

// ---------- Fin indicateur RH ----------

// ---------- Suivi Managers (16/09) ----------
// Trames d'entretien manager (Écoute&FB, Pilotage Audio, Pilotage Optique) +
// lancements de journée. Même principe que store-observation : écriture
// publique protégée par X-Store-Token, résolution animateur/magasin côté
// serveur depuis magasins.csv (jamais fait confiance au client), mail au
// magasin à l'envoi. Historique réservé aux AR + Olivier via /ar-login.
if (url.pathname === '/entretien-manager') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const body = await request.json();
const { type, magasinCode, collaborateurMatricule, collaborateurNom, remplipar, date, data, pdfBase64, pdfFilename } = body;
if (!['ecoute_fb', 'pilotage_audio', 'pilotage_optique', 'recadrage'].includes(type)) return jsonError('Type invalide', 400, corsHeaders);
if (!remplipar || !date) return jsonError('Champs manquants', 400, corsHeaders);

const stores = await getMagasinsServerSide();
const magasin = stores.find(s => String(s.code) === String(magasinCode)) || null;
const animateur = magasin ? magasin.animateur : null;

await env.DB.prepare(
`INSERT INTO entretiens_manager
(type, magasin_code, magasin_libelle, animateur, collaborateur_matricule, collaborateur_nom, rempli_par, date, data_json)
VALUES (?,?,?,?,?,?,?,?,?)`
).bind(
type, magasinCode || null, magasin ? magasin.libelle : null, animateur,
collaborateurMatricule || null, collaborateurNom || null, remplipar, date, JSON.stringify(data || {})
).run();

if (magasin && magasin.email) {
const libelles = { ecoute_fb: 'Écoute & Feedback de vente', pilotage_audio: 'Pilotage Audio', pilotage_optique: 'Pilotage Optique', recadrage: 'Entretien de recadrage' };
const subject = `Entretien manager — ${libelles[type]} — ${magasin.libelle} — ${formatDateFr(date)}`;
const bodyHtml = buildEntretienManagerEmailHtml({ libelleType: libelles[type], magasin, remplipar, date, data, collaborateurNom, hasPdf: !!pdfBase64 });
try {
if (pdfBase64) {
await zimbraSendMailWithAttachment(env, { to: magasin.email, subject, bodyHtml, pdfBase64, filename: pdfFilename });
} else {
await zimbraSendMail(env, { to: magasin.email, subject, bodyHtml });
}
} catch (e) { console.error('Échec envoi mail entretien manager:', e); }
}

return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur enregistrement entretien : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/lancement-journee') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const body = await request.json();
const { magasinCode, remplipar, posteRemplipar, date, presents, objectifs, noteLibre, mensuel, pdfBase64, pdfFilename } = body;
if (!remplipar || !posteRemplipar || !date) return jsonError('Champs manquants', 400, corsHeaders);

const stores = await getMagasinsServerSide();
const magasin = stores.find(s => String(s.code) === String(magasinCode)) || null;
const animateur = magasin ? magasin.animateur : null;

await env.DB.prepare(
`INSERT INTO lancements_journee
(magasin_code, magasin_libelle, animateur, rempli_par, poste_rempli_par, date, presents_json, objectifs, note_libre, mensuel_json)
VALUES (?,?,?,?,?,?,?,?,?,?)`
).bind(
magasinCode || null, magasin ? magasin.libelle : null, animateur,
remplipar, posteRemplipar, date, JSON.stringify(presents || []), objectifs || '', noteLibre || '', JSON.stringify(mensuel || {})
).run();

if (magasin && magasin.email) {
const subject = `Lancement de journée — ${magasin.libelle} — ${formatDateFr(date)}`;
const mensuelLabels = { ca: 'CA', positionnement: 'Positionnement mensuel', caAudio: 'CA audio', nbVenteOpt: 'Nb de vente optique', nbProthese: 'Nb de prothèses' };
const mensuelLine = mensuel ? Object.entries(mensuelLabels).filter(([k]) => mensuel[k]).map(([k, label]) => `${label} : ${escapeHtml(String(mensuel[k]))}`).join(' — ') : '';
const bodyHtml = pdfBase64
  ? `<div style="font-family:Arial,sans-serif;"><h2 style="color:#CC1719;">Lancement de journée</h2><p><b>Magasin :</b> ${escapeHtml(magasin.libelle)}</p><p><b>Réalisé par :</b> ${escapeHtml(remplipar)} (${escapeHtml(posteRemplipar)}) — <b>Date :</b> ${escapeHtml(formatDateFr(date))}</p><p>Le compte-rendu complet est joint à ce mail au format PDF.</p></div>`
  : `<div style="font-family:Arial,sans-serif;"><h2 style="color:#CC1719;">Lancement de journée</h2><p><b>Magasin :</b> ${escapeHtml(magasin.libelle)}</p><p><b>Réalisé par :</b> ${escapeHtml(remplipar)} (${escapeHtml(posteRemplipar)}) — <b>Date :</b> ${escapeHtml(formatDateFr(date))}</p>${mensuelLine ? `<p><b>Données du mois :</b> ${mensuelLine}</p>` : ''}<p><b>Présents :</b> ${escapeHtml((presents || []).join(', '))}</p><p><b>Objectifs du jour :</b><br>${escapeHtml(objectifs || '').replace(/\n/g, '<br>')}</p><p><b>Note libre :</b><br>${escapeHtml(noteLibre || '').replace(/\n/g, '<br>')}</p></div>`;
try {
if (pdfBase64) {
await zimbraSendMailWithAttachment(env, { to: magasin.email, subject, bodyHtml, pdfBase64, filename: pdfFilename });
} else {
await zimbraSendMail(env, { to: magasin.email, subject, bodyHtml });
}
} catch (e) { console.error('Échec envoi mail lancement journée:', e); }
}

return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur enregistrement lancement : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/historique-managers') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

try {
let allowedCodes = null;
if (sessionAr !== 'ALL') {
const stores = await getMagasinsServerSide();
allowedCodes = stores.filter(s => s.animateur === sessionAr).map(s => s.code);
}
const magasinCode = url.searchParams.get('magasin_code');
if (magasinCode && allowedCodes && !allowedCodes.includes(magasinCode)) return jsonError('Accès non autorisé à ce magasin', 403, corsHeaders);
const type = url.searchParams.get('type');
const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);

const scopeClause = (col) => {
if (magasinCode) return { sql: ` AND ${col} = ?`, binds: [magasinCode] };
if (allowedCodes) return allowedCodes.length ? { sql: ` AND ${col} IN (${allowedCodes.map(() => '?').join(',')})`, binds: allowedCodes } : { sql: ' AND 0', binds: [] };
return { sql: '', binds: [] };
};

const result = { entretiens: [], lancements: [] };

if (type !== 'lancements') {
const sc = scopeClause('magasin_code');
const { results } = await env.DB.prepare(
`SELECT * FROM entretiens_manager WHERE 1=1${sc.sql} ORDER BY date DESC, id DESC LIMIT ?`
).bind(...sc.binds, limit).all();
result.entretiens = results.map(r => ({ ...r, data_json: JSON.parse(r.data_json || '{}') }));
}
if (type !== 'entretiens') {
const sc = scopeClause('magasin_code');
const { results } = await env.DB.prepare(
`SELECT * FROM lancements_journee WHERE 1=1${sc.sql} ORDER BY date DESC, id DESC LIMIT ?`
).bind(...sc.binds, limit).all();
result.lancements = results.map(r => ({ ...r, presents_json: JSON.parse(r.presents_json || '[]'), mensuel_json: JSON.parse(r.mensuel_json || '{}') }));
}

return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture historique : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/collab-stats') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const matricules = (url.searchParams.get('matricules') || '').split(',').map(s => s.trim()).filter(Boolean);
if (!matricules.length) return new Response(JSON.stringify({ ok: true, collaborateurs: {} }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

const placeholders = matricules.map(() => '?').join(',');
const { results } = await env.DB.prepare(
`SELECT c1.matricule, c1.periode, c1.nom_vendeur,
c1.pm_opt AS pmOpt, c1.mdc AS mdc, c1.nb_vente_opt AS nbVenteOpt, c1.sop AS sop,
c1.tx_concret_opt AS txConcretOpt, c1.pack_confort_pct AS packConfortPct, c1.pack_confort_pm AS packConfortPm,
c1.pm_1ere_paire AS pm1erePaire, c1.pm_audio AS pmAudio, c1.tx_concret_audio AS txConcretAudio,
c1.ap4 AS ap4, c1.pct_test_auditif AS pctTestAuditif, c1.ca_audio AS caAudio, c1.ca_accessoires_pct AS caAccessoiresPct
FROM collab_stats_mensuel c1
INNER JOIN (
SELECT matricule, MAX(periode) AS maxp FROM collab_stats_mensuel WHERE matricule IN (${placeholders}) GROUP BY matricule
) c2 ON c1.matricule = c2.matricule AND c1.periode = c2.maxp`
).bind(...matricules).all();

const collaborateurs = {};
for (const row of results) collaborateurs[row.matricule] = row;
return new Response(JSON.stringify({ ok: true, collaborateurs }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture stats collaborateur : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/collab-stats-capture') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const body = await request.json();
const { periode, rows } = body;
if (!periode || !Array.isArray(rows) || !rows.length) return jsonError('Données manquantes', 400, corsHeaders);

const stmt = env.DB.prepare(
`INSERT INTO collab_stats_mensuel
(matricule, periode, nom_vendeur, pm_opt, mdc, nb_vente_opt, sop, tx_concret_opt, pack_confort_pct, pack_confort_pm,
pm_1ere_paire, pm_audio, tx_concret_audio, ap4, pct_test_auditif, ca_audio, ca_accessoires_pct, updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
ON CONFLICT(matricule, periode) DO UPDATE SET
nom_vendeur=excluded.nom_vendeur, pm_opt=excluded.pm_opt, mdc=excluded.mdc, nb_vente_opt=excluded.nb_vente_opt,
sop=excluded.sop, tx_concret_opt=excluded.tx_concret_opt, pack_confort_pct=excluded.pack_confort_pct,
pack_confort_pm=excluded.pack_confort_pm, pm_1ere_paire=excluded.pm_1ere_paire, pm_audio=excluded.pm_audio,
tx_concret_audio=excluded.tx_concret_audio, ap4=excluded.ap4, pct_test_auditif=excluded.pct_test_auditif,
ca_audio=excluded.ca_audio, ca_accessoires_pct=excluded.ca_accessoires_pct, updated_at=datetime('now')`
);
const batch = rows
.filter(r => r.matricule && r.matricule !== 'null' && r.matricule.trim() !== '-')
.map(r => stmt.bind(
r.matricule, periode, r.nomVendeur || null,
r.pmOpt ?? null, r.mdc ?? null, r.nbVenteOpt ?? null, r.sop ?? null, r.txConcretOpt ?? null,
r.packConfortPct ?? null, r.packConfortPm ?? null, r.pm1erePaire ?? null,
r.pmAudio ?? null, r.txConcretAudio ?? null, r.ap4 ?? null,
r.pctTestAuditif ?? null, r.caAudio ?? null, r.caAccessoiresPct ?? null
));
if (batch.length) await env.DB.batch(batch);

return new Response(JSON.stringify({ ok: true, count: batch.length }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur capture stats collaborateur : ' + String(e), 500, corsHeaders);
}
}

// Suivi Managers (17/09) — données mensuelles magasin, réutilisées à deux
// endroits : le ratio "CA audio/CA mag" de Pilotage Audio, et le bloc de
// données mensuelles en tête du Lancement de journée. Toujours la ligne
// store_stats la plus récente pour ce magasin (même logique que
// getStoreStatsMap, réutilisée telle quelle plutôt que dupliquée).
if (url.pathname === '/store-monthly-stats') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const magasinCode = url.searchParams.get('magasin_code');
if (!magasinCode) return jsonError('magasin_code requis', 400, corsHeaders);
const stores = await getMagasinsServerSide();
const store = stores.find(s => String(s.code) === String(magasinCode));
if (!store) return new Response(JSON.stringify({ ok: true, periode: null }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

const statsMap = await getStoreStatsMap(env);
const row = statsMap[normalizeName(store.libelle)];
if (!row) return new Response(JSON.stringify({ ok: true, periode: null }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

const caTotal = row.ca_total != null ? Number(row.ca_total) : null;
const caAudio = row.ca_audio != null ? Number(row.ca_audio) : null;
const objectif = row.objectif != null ? Number(row.objectif) : null;
const raf = row.raf != null ? Number(row.raf) : null;
const positionnementMensuel = (objectif && objectif !== 0)
? Math.round(((objectif - (raf || 0)) / objectif) * 1000) / 10
: null;
const caAudioMagPct = (caTotal && caTotal !== 0 && caAudio != null)
? Math.round((caAudio / caTotal) * 1000) / 10
: null;
// ca_total / ca_audio / ca_opt sont stockés en k€ dans store_stats (même
// convention que le reste du Worker, ex. les digests "CA: Xk€") — convertis
// ici en € entiers pour l'affichage Lancement/Pilotage, jamais montrés bruts.
const toEurosRounded = (kEuros) => kEuros != null ? Math.round(kEuros * 1000) : null;

return new Response(JSON.stringify({
ok: true, periode: row.periode || null,
caTotal: toEurosRounded(caTotal), caAudio: toEurosRounded(caAudio), caOpt: toEurosRounded(row.ca_opt != null ? Number(row.ca_opt) : null),
nbVenteOpt: row.nb_vente_opt != null ? Number(row.nb_vente_opt) : null,
protheses: row.protheses_vendues != null ? Number(row.protheses_vendues) : null,
positionnementMensuel, caAudioMagPct,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture stats mensuelles magasin : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/rh-collaborateurs') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const magasinCode = url.searchParams.get('magasin_code');
if (!magasinCode) return jsonError('magasin_code requis', 400, corsHeaders);

const moisRow = await env.DB.prepare(
`SELECT MAX(mois) as mois FROM rh_effectif_site_mensuel WHERE code_site = ? AND site_reconnu = 1`
).bind(magasinCode).first();
const dernierMois = moisRow && moisRow.mois;
if (!dernierMois) return new Response(JSON.stringify({ ok: true, mois: null, collaborateurs: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

const { results } = await env.DB.prepare(
`SELECT es.matricule, (em.prenom || ' ' || em.nom) AS nom, em.poste
FROM rh_effectif_site_mensuel es
JOIN rh_effectif_mensuel em ON em.mois = es.mois AND em.matricule = es.matricule
WHERE es.code_site = ? AND es.mois = ? AND es.site_reconnu = 1
ORDER BY em.nom`
).bind(magasinCode, dernierMois).all();

return new Response(JSON.stringify({ ok: true, mois: dernierMois, collaborateurs: results }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture collaborateurs : ' + String(e), 500, corsHeaders);
}
}
// ---------- Fin Suivi Managers ----------

if (url.pathname === '/store-observation') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const o = await request.json();
if (!o.m || !o.th || !o.tx || !o.t || !o.d) return jsonError('Champs requis manquants', 400, corsHeaders);
await env.DB.prepare(
`INSERT INTO observations (obs_id, magasin, theme, tone, texte, jour_label, date_key)
VALUES (?, ?, ?, ?, ?, ?, ?)`
).bind(o.id || null, o.m, o.th, o.t, o.tx, o.dl || null, o.d).run();

if (o.m !== 'Info générale') {
try {
await env.DB.prepare(
`INSERT INTO observation_last_visit (magasin, last_date) VALUES (?, ?)
ON CONFLICT(magasin) DO UPDATE SET last_date = CASE WHEN excluded.last_date > last_date THEN excluded.last_date ELSE last_date END`
).bind(o.m, o.d).run();
} catch(e) { console.error('Erreur maj observation_last_visit:', e); }
}

return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur enregistrement : ' + String(e), 500, corsHeaders);
}
}

// /obs-generate et /obs-send retirés le 21/08 : les observations terrain
// partent désormais automatiquement dans le com hebdo du dimanche (voir
// generateComHebdo/generateComHebdoForAR) au lieu d'un envoi manuel dédié.

// /obs-day-close (22/08) : clôture de journée depuis le bouton "Terminer la
// journée" d'Observations Terrain — un mail par magasin visité ce jour-là,
// à Olivier uniquement, en plus (pas à la place) du com hebdo du dimanche.
if (url.pathname === '/obs-day-close') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
try {
const body = await request.json();
if (!Array.isArray(body.items) || !body.items.length) return jsonError('Aucune observation à envoyer', 400, corsHeaders);
const result = await sendObsDayCloseEmails(env, body);
return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur envoi clôture journée : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/com-hebdo') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (sessionAr !== 'ALL') return jsonError('Fonctionnalité réservée au profil réseau complet', 403, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const { from, to, blocks } = await generateComHebdo(env);
return new Response(JSON.stringify({ ok: true, from, to, blocks }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération com hebdo : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-com-hebdo') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sendMode = url.searchParams.get('send');
const arFilter = url.searchParams.get('ar');
const overrideFrom = url.searchParams.get('from');
const overrideTo = url.searchParams.get('to');
const override = (overrideFrom && overrideTo) ? { from: overrideFrom, to: overrideTo } : null;
try {
const { from, to, blocks, coverage } = await generateComHebdo(env, override);
if (sendMode === 'all') {
const result = await sendComHebdo(env, override, arFilter || null);
return new Response(JSON.stringify({ ok: true, sendMode, arFilter: arFilter || null, from, to, failures: result.failures }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} else if (sendMode === '1') {
const subject = `Com hebdo réseau (brouillon) — semaine du ${from.split('-').reverse().join('/')} au ${to.split('-').reverse().join('/')}`;
await zimbraSendMail(env, { to: OLIVIER_EMAIL, subject, bodyText: formatComHebdoAsEmail(blocks) });
}
return new Response(JSON.stringify({ ok: true, sendMode: sendMode || 'preview', from, to, blocks, coverage }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération/envoi com hebdo : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-weekly-report') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sendEmail = url.searchParams.get('send') === '1';
const arFilter = url.searchParams.get('ar');
const overrideFrom = url.searchParams.get('from');
const overrideTo = url.searchParams.get('to');
const override = (overrideFrom && overrideTo) ? { from: overrideFrom, to: overrideTo } : null;
try {
const { subject, byAR, byArBullets, coverage, debugInfo } = await generateWeeklyReport(env, override);
const arStats = computeArStats(byAR);
let sentTo = [];
if (sendEmail) {
await sendWeeklyReport(env, override, arFilter || null);
if (arFilter) {
const stores = await getMagasinsServerSide();
const arEmail = getArEmail(stores, arFilter);
sentTo = arEmail ? [arEmail] : [];
} else {
sentTo = [OLIVIER_EMAIL];
}
}
return new Response(JSON.stringify({
ok: true, emailSent: sendEmail, sentTo, subject, arStats, byArBullets, coverage, debugInfo
}, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération/envoi du rapport : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/debug-magasins-non-reconnus') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const stores = await getMagasinsServerSide();
const storeStatsMap = await getStoreStatsMap(env);
const unmatchedNames = findUnmatchedStoreStatsNames(stores, storeStatsMap);
const detail = unmatchedNames.map(nom => {
const suggestion = suggestClosestStore(normalizeName(nom), stores);
return {
nomRecu: nom,
cleNormalisee: normalizeName(nom),
suggestion: suggestion ? {
libelleMagasinsCsv: suggestion.libelle,
codeMagasin: suggestion.code,
distanceEdition: suggestion.distance,
confiance: suggestion.confiance,
} : null,
};
});
return new Response(JSON.stringify({
ok: true,
nbMagasinsConnus: stores.length,
nbNomsRecusAuTotal: Object.keys(storeStatsMap).length,
nbNomsNonReconnus: detail.length,
magasinsNonReconnus: detail,
}, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur calcul noms non reconnus : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-monthly-report') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sendEmail = url.searchParams.get('send') === '1';
const overrideFrom = url.searchParams.get('from');
const overrideTo = url.searchParams.get('to');
const override = (overrideFrom && overrideTo) ? { from: overrideFrom, to: overrideTo } : null;
try {
const { subject, from, to, arStats, byArBullets, weeklyRowsCount } = await generateMonthlyReport(env, override);
let sentTo = [];
if (sendEmail) {
await sendMonthlyReport(env, override);
sentTo = [OLIVIER_EMAIL];
}
return new Response(JSON.stringify({
ok: true, emailSent: sendEmail, sentTo, subject, from, to, weeklyRowsCount, arStats, byArBullets
}, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération/envoi du bilan mensuel : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-kaizen-cloture') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
// mois au format YYYY-MM, optionnel — par défaut le mois précédent (comportement réel du cron)
const moisParam = url.searchParams.get('mois');
if (moisParam && !/^\d{4}-\d{2}$/.test(moisParam)) return jsonError('Paramètre mois invalide, format attendu YYYY-MM', 400, corsHeaders);
const commit = url.searchParams.get('commit') === '1';
try {
if (!commit) {
const preview = await previewCloturesKaizen(env, moisParam);
return new Response(JSON.stringify({ ok: true, mode: 'preview', note: 'Aucune écriture D1, aucun email envoyé. Ajouter &commit=1 pour exécuter réellement la clôture.', ...preview }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} else {
const avant = await previewCloturesKaizen(env, moisParam);
await cloturerAuditsKaizen(env, moisParam);
const apres = await previewCloturesKaizen(env, moisParam);
return new Response(JSON.stringify({ ok: true, mode: 'commit', mois: avant.mois, cloturesEffectuees: avant.aCloturer, restantANonClos: apres.totalACloturer }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
}
} catch (e) {
return jsonError('Erreur test clôture Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/google-ratings') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
const { results } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count, updated_at FROM google_ratings').all();
const ratings = {};
for (const r of results) {
ratings[r.magasin_code] = { rating: r.rating, reviewsCount: r.reviews_count, updatedAt: r.updated_at };
}
return new Response(JSON.stringify({ ok: true, ratings }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture google_ratings : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-google-ratings-refresh') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
try {
await refreshGoogleRatings(env);
const { results } = await env.DB.prepare('SELECT magasin_code, rating, reviews_count, updated_at FROM google_ratings ORDER BY magasin_code').all();
return new Response(JSON.stringify({ ok: true, count: results.length, results }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur refresh Google ratings : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/test-visit-reminders') {
const storeToken = request.headers.get('X-Store-Token') || url.searchParams.get('token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sendEmail = url.searchParams.get('send') === '1';
try {
const stores = await getMagasinsServerSide();
const lastVisitMap = await getLastVisitMap(env);
const todayISO = new Date().toISOString().slice(0, 10);
const overdueAll = computeOverdueStores(stores, lastVisitMap, todayISO);
if (sendEmail) await sendVisitReminders(env);
return new Response(JSON.stringify({ ok: true, emailSent: sendEmail, count: overdueAll.length, overdueAll }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur génération/envoi relance visite : ' + String(e), 500, corsHeaders);
}
}

// ============================================================
// Évaluation Équipe — routes (ajoutées 06/08/2026)
// ============================================================

if (url.pathname === '/evaluation/controle') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const { magasin_code, magasin_libelle, tache, criteres } = await request.json();
if (!magasin_code || !tache || !Array.isArray(criteres) || criteres.length !== 10) {
return jsonError('Payload invalide : magasin_code, tache et 10 critères requis', 400, corsHeaders);
}

if (sessionAr !== 'ALL') {
const stores = await getMagasinsServerSide();
const allowed = stores.some(s => s.code === magasin_code && s.animateur === sessionAr);
if (!allowed) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
}

const note = criteres.filter(Boolean).length;
const annee = anneeCouranteEval();
const date_controle = new Date().toISOString().slice(0, 10);

try {
await env.DB.prepare(`
INSERT INTO notes_equipe
(magasin_code, magasin_libelle, tache, annee, note, criteres_json, date_controle, source, ar_login, ar_nom)
VALUES (?, ?, ?, ?, ?, ?, ?, 'saisie', ?, ?)
`).bind(magasin_code, magasin_libelle || magasin_code, tache, annee, note, JSON.stringify(criteres), date_controle, sessionAr, sessionAr).run();
} catch (e) {
return jsonError('Erreur enregistrement contrôle : ' + String(e), 500, corsHeaders);
}

return new Response(JSON.stringify({ ok: true, note, date_controle }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/evaluation/magasin') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const code = url.searchParams.get('code');
if (!code) return jsonError('Paramètre code requis', 400, corsHeaders);

if (sessionAr !== 'ALL') {
const stores = await getMagasinsServerSide();
const allowed = stores.some(s => s.code === code && s.animateur === sessionAr);
if (!allowed) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
}

try {
const annee = anneeCouranteEval();

const { results: notes } = await env.DB.prepare(`
SELECT id, tache, note, date_controle, ar_nom, source, criteres_json
FROM notes_equipe WHERE magasin_code = ? AND annee = ?
ORDER BY tache, created_at DESC
`).bind(code, annee).all();

const { results: fiches } = await env.DB.prepare(`
SELECT tache, responsable, responsable_depuis, second, second_depuis
FROM responsables_taches WHERE magasin_code = ?
`).bind(code).all();

const { results: criteresRows } = await env.DB.prepare(`
SELECT tache, ordre, libelle FROM criteres_taches
WHERE active_depuis_annee <= ? ORDER BY tache, ordre
`).bind(annee).all();

const parTache = {};
for (const c of criteresRows) {
(parTache[c.tache] ??= { criteres: [], notes: [] }).criteres.push(c.libelle);
}
for (const n of notes) {
(parTache[n.tache] ??= { criteres: [], notes: [] }).notes.push(n);
}
for (const f of fiches) {
parTache[f.tache] ??= { criteres: [], notes: [] };
parTache[f.tache].fiche = f;
}

const taches = Object.entries(parTache).map(([tache, data]) => {
const meilleures = [...data.notes].sort((a, b) => b.note - a.note).slice(0, 3);
const moyenne = meilleures.length
? Math.round((meilleures.reduce((s, n) => s + n.note, 0) / meilleures.length) * 10) / 10
: null;
return {
tache,
nb_criteres: data.criteres.length,
criteres: data.criteres,
fiche: data.fiche || null,
nb_controles: data.notes.length,
moyenne_3_meilleures: moyenne,
dernier_controle: data.notes[0] || null,
historique: data.notes,
};
});

const moyennesValides = taches.filter(t => t.moyenne_3_meilleures !== null);
const niveauEquipe = moyennesValides.length
? Math.round((moyennesValides.reduce((s, t) => s + t.moyenne_3_meilleures, 0) / moyennesValides.length) * 10) / 10
: null;

return new Response(JSON.stringify({
ok: true, magasin_code: code, annee,
niveau_equipe: niveauEquipe, objectif: OBJECTIF_NIVEAU_EQUIPE, taches,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture magasin : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/evaluation/fiche') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

const { magasin_code, tache, responsable, responsable_depuis, second, second_depuis } = await request.json();
if (!magasin_code || !tache) return jsonError('magasin_code et tache requis', 400, corsHeaders);

if (sessionAr !== 'ALL') {
const stores = await getMagasinsServerSide();
const allowed = stores.some(s => s.code === magasin_code && s.animateur === sessionAr);
if (!allowed) return jsonError('Magasin hors de votre périmètre', 403, corsHeaders);
}

try {
await env.DB.prepare(`
INSERT INTO responsables_taches (magasin_code, tache, responsable, responsable_depuis, second, second_depuis)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT (magasin_code, tache) DO UPDATE SET
responsable = excluded.responsable, responsable_depuis = excluded.responsable_depuis,
second = excluded.second, second_depuis = excluded.second_depuis, updated_at = datetime('now')
`).bind(magasin_code, tache, responsable || null, responsable_depuis || null, second || null, second_depuis || null).run();
} catch (e) {
return jsonError('Erreur enregistrement fiche : ' + String(e), 500, corsHeaders);
}

return new Response(JSON.stringify({ ok: true }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/evaluation/correction') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (sessionAr !== 'ALL') return jsonError('Seul Olivier peut corriger une note', 403, corsHeaders);

const { id, criteres } = await request.json();
if (!id || !Array.isArray(criteres) || criteres.length !== 10) {
return jsonError('id et 10 critères requis', 400, corsHeaders);
}
const note = criteres.filter(Boolean).length;

try {
await env.DB.prepare(`
UPDATE notes_equipe SET note = ?, criteres_json = ?, modifie_par = ?, modifie_le = datetime('now')
WHERE id = ?
`).bind(note, JSON.stringify(criteres), sessionAr, id).run();
} catch (e) {
return jsonError('Erreur correction : ' + String(e), 500, corsHeaders);
}

return new Response(JSON.stringify({ ok: true, note }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/evaluation/supprimer-controle') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (sessionAr !== 'ALL') return jsonError('Seul Olivier peut supprimer un contrôle', 403, corsHeaders);

const { id } = await request.json();
if (!id) return jsonError('id requis', 400, corsHeaders);

try {
await env.DB.prepare('DELETE FROM notes_equipe WHERE id = ?').bind(id).run();
} catch (e) {
return jsonError('Erreur suppression : ' + String(e), 500, corsHeaders);
}

return new Response(JSON.stringify({ ok: true }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}

if (url.pathname === '/evaluation/reseau') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);

try {
const annee = anneeCouranteEval();
const stores = await getMagasinsServerSide();
const allowedCodes = sessionAr === 'ALL' ? null : new Set(stores.filter(s => s.animateur === sessionAr).map(s => s.code));

const { results: activeTachesRows } = await env.DB.prepare(`
SELECT DISTINCT tache FROM criteres_taches WHERE active_depuis_annee <= ?
`).bind(annee).all();
const activeTaches = activeTachesRows.map(r => r.tache);

const { results: notes } = await env.DB.prepare(`
SELECT magasin_code, magasin_libelle, tache, note FROM notes_equipe WHERE annee = ?
`).bind(annee).all();

const parMagasin = {};
for (const n of notes) {
if (allowedCodes && !allowedCodes.has(n.magasin_code)) continue;
const m = (parMagasin[n.magasin_code] ??= { taches: {} });
(m.taches[n.tache] ??= []).push(n.note);
}

const niveaux = {};
const controles = {};
for (const [code, data] of Object.entries(parMagasin)) {
const moyennes = Object.values(data.taches).map(notesArr => {
const top3 = [...notesArr].sort((a, b) => b - a).slice(0, 3);
return top3.reduce((s, n) => s + n, 0) / top3.length;
});
niveaux[code] = moyennes.length
? Math.round((moyennes.reduce((s, m2) => s + m2, 0) / moyennes.length) * 10) / 10
: null;

const minControles = activeTaches.length
? Math.min(...activeTaches.map(t => (data.taches[t] || []).length))
: 0;
controles[code] = Math.min(minControles, 3);
}

return new Response(JSON.stringify({ ok: true, annee, niveaux, controles }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur calcul niveaux réseau : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/evaluation/export-reseau') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur invalide ou expirée, reconnecte-toi.', 401, corsHeaders);
if (sessionAr !== 'ALL') return jsonError('Réservé à Olivier', 403, corsHeaders);

try {
const csv = await buildNiveauxEvalCsv(env);
return new Response('﻿' + csv, {
status: 200,
headers: {
'Content-Type': 'text/csv; charset=utf-8',
'Content-Disposition': `attachment; filename="evaluation-equipe-${anneeCouranteEval()}.csv"`,
...corsHeaders,
},
});
} catch (e) {
return jsonError('Erreur export réseau : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-etat') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const code = url.searchParams.get('code');
const mois = url.searchParams.get('mois');
if (!code || !mois) return jsonError('Paramètres code et mois requis', 400, corsHeaders);

try {
const stores = await getMagasinsServerSide();
const store = stores.find(s => s.code === code);
if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);

const zones = await getKaizenReferentiel();
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);

const row = await env.DB.prepare(
`SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
).bind(code, mois).first();

const itemsState = row ? JSON.parse(row.items_json) : {};
const { score, scoreMax } = kaizenComputeScore(itemsState, itemsApplicables);

return new Response(JSON.stringify({
ok: true,
magasin_code: code,
magasin_libelle: store.libelle,
concept: store.concept,
meuble_vitrine: store.meubleVitrine,
presentoir_verres: store.presentoirVerres,
mois,
zones,
items_state: itemsState,
score, score_max: scoreMax,
closed: row ? !!row.closed : false,
imported: row ? !!row.imported : false,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur lecture audit Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-toggle') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const { magasin_code, mois, item_id, checked, controleur } = await request.json();
if (!magasin_code || !mois || !item_id || !controleur) {
return jsonError('Payload invalide : magasin_code, mois, item_id et controleur requis', 400, corsHeaders);
}

// Mode "visite de contrôle" (14/09) : un AR ou Olivier authentifié (vraie
// session Zimbra, réutilise /ar-login comme Bilan de Passage) qui coche/décoche
// un item verrouille cet item précis — le magasin garde un accès libre et sans
// connexion sur tout le reste de l'audit, mais ne peut plus retoucher CET item
// tant qu'un AR/Olivier authentifié ne l'a pas explicitement déverrouillé
// (route /kaizen-lock) ou que le mois suivant ne remette l'audit à zéro.
// Sans session valide, sessionAr est null (comportement magasin inchangé).
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));

try {
const stores = await getMagasinsServerSide();
const store = stores.find(s => s.code === magasin_code);
if (!store) return jsonError('Magasin inconnu', 404, corsHeaders);

const existing = await env.DB.prepare(
`SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
).bind(magasin_code, mois).first();

if (existing && existing.closed) {
return jsonError('Cet audit est clôturé, il ne peut plus être modifié', 409, corsHeaders);
}

const itemsState = existing ? JSON.parse(existing.items_json) : {};

const currentItem = itemsState[item_id];
if (currentItem && currentItem.locked && !sessionAr) {
const parDepuis = currentItem.locked_by ? `par ${currentItem.locked_by} ` : '';
const depuisLe = currentItem.locked_at ? `le ${currentItem.locked_at.slice(0, 10)} ` : '';
return jsonError(`Cet item a été verrouillé ${parDepuis}${depuisLe}lors d'une visite de contrôle — seul un animateur réseau authentifié peut le déverrouiller.`, 423, corsHeaders);
}

itemsState[item_id] = {
checked: !!checked,
// Identité fiable quand authentifié (issue de la session vérifiée, pas du
// champ texte libre) ; sinon comportement magasin inchangé (prénom saisi).
controleur: sessionAr || controleur,
checked_at: new Date().toISOString(),
locked: !!sessionAr,
locked_by: sessionAr || null,
locked_at: sessionAr ? new Date().toISOString() : null,
};

const zones = await getKaizenReferentiel();
const itemsApplicables = kaizenItemsApplicables(zones, store.concept);
const { score, scoreMax } = kaizenComputeScore(itemsState, itemsApplicables);

if (existing) {
await env.DB.prepare(
`UPDATE kaizen_audits SET items_json = ?, score = ?, score_max = ?, updated_at = datetime('now') WHERE id = ?`
).bind(JSON.stringify(itemsState), score, scoreMax, existing.id).run();
} else {
await env.DB.prepare(
`INSERT INTO kaizen_audits (magasin_code, mois, items_json, score, score_max) VALUES (?, ?, ?, ?, ?)`
).bind(magasin_code, mois, JSON.stringify(itemsState), score, scoreMax).run();
}

return new Response(JSON.stringify({ ok: true, score, score_max: scoreMax, locked: !!sessionAr }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur sauvegarde audit Kaizen : ' + String(e), 500, corsHeaders);
}
}

// Déverrouillage (ou verrouillage manuel sans toucher checked/controleur) d'un
// item — toujours réservé à un AR/Olivier authentifié. Utilisée principalement
// pour rendre un item verrouillé à nouveau modifiable par le magasin, sans que
// l'AR ait besoin de re-cocher/décocher l'item pour ça.
if (url.pathname === '/kaizen-lock') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (!sessionAr) return jsonError('Session animateur réseau requise pour verrouiller/déverrouiller un item', 401, corsHeaders);

const { magasin_code, mois, item_id, locked } = await request.json();
if (!magasin_code || !mois || !item_id || typeof locked !== 'boolean') {
return jsonError('Payload invalide : magasin_code, mois, item_id et locked (booléen) requis', 400, corsHeaders);
}

try {
const existing = await env.DB.prepare(
`SELECT * FROM kaizen_audits WHERE magasin_code = ? AND mois = ?`
).bind(magasin_code, mois).first();
if (!existing) return jsonError('Aucun audit trouvé pour ce magasin/mois', 404, corsHeaders);
if (existing.closed) return jsonError('Cet audit est clôturé, il ne peut plus être modifié', 409, corsHeaders);

const itemsState = JSON.parse(existing.items_json);
if (!itemsState[item_id]) return jsonError('Aucun contrôle existant pour cet item', 404, corsHeaders);

itemsState[item_id] = {
...itemsState[item_id],
locked,
locked_by: locked ? sessionAr : null,
locked_at: locked ? new Date().toISOString() : null,
};

await env.DB.prepare(
`UPDATE kaizen_audits SET items_json = ?, updated_at = datetime('now') WHERE id = ?`
).bind(JSON.stringify(itemsState), existing.id).run();

return new Response(JSON.stringify({ ok: true, locked }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur verrouillage item Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-photo' && request.method === 'POST') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.KAIZEN_PHOTOS) return jsonError('Bucket R2 non lié au Worker (binding KAIZEN_PHOTOS manquant)', 500, corsHeaders);

const key = url.searchParams.get('key');
const code = url.searchParams.get('code');
if (!key || !code) return jsonError('Paramètres key et code requis', 400, corsHeaders);
if (!key.startsWith(code + '/')) return jsonError('Clé photo invalide pour ce magasin', 400, corsHeaders);

try {
const contentType = request.headers.get('Content-Type') || 'image/jpeg';
const bytes = await request.arrayBuffer();
await env.KAIZEN_PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
return new Response(JSON.stringify({ ok: true, key }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur upload photo Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-photo' && request.method === 'GET') {
if (!env.KAIZEN_PHOTOS) return jsonError('Bucket R2 non lié au Worker (binding KAIZEN_PHOTOS manquant)', 500, corsHeaders);

const key = url.searchParams.get('key');
if (!key) return jsonError('Paramètre key requis', 400, corsHeaders);

try {
const object = await env.KAIZEN_PHOTOS.get(key);
if (!object) return jsonError('Photo introuvable', 404, corsHeaders);
return new Response(object.body, {
status: 200,
headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur lecture photo Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-historique') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);

const code = url.searchParams.get('code');
if (!code) return jsonError('Paramètre code requis', 400, corsHeaders);

try {
const { results } = await env.DB.prepare(
`SELECT mois, score, score_max, closed, imported FROM kaizen_audits WHERE magasin_code = ? ORDER BY mois DESC LIMIT 12`
).bind(code).all();

const anneeCourante = new Date().getFullYear().toString();
const cumulAnnuel = Math.round(
results.filter(r => r.mois.startsWith(anneeCourante)).reduce((s, r) => s + (r.score || 0), 0) * 10
) / 10;

return new Response(JSON.stringify({ ok: true, historique: results, cumul_annuel: cumulAnnuel }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur historique Kaizen : ' + String(e), 500, corsHeaders);
}
}

// Import ponctuel de l'historique Kaizen pré-app (Google Forms / Excel, sans
// détail par item — score global seulement). Réservé à Olivier (session ALL).
// Chaque ligne importée est marquée `imported = 1` pour pouvoir tout annuler
// proprement via /kaizen-import-historique-rollback. N'écrase JAMAIS un mois
// déjà présent en base (natif ou déjà importé) — uniquement les mois absents.
const KZ_IMPORT_ALIASES = { '001046M': '1046', 'P01001': '1001' };

if (url.pathname === '/kaizen-import-historique') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (sessionAr !== 'ALL') return jsonError('Réservé à Olivier', 403, corsHeaders);

try {
const body = await request.json();
const rows = Array.isArray(body.rows) ? body.rows : [];
if (!rows.length) return jsonError('Aucune ligne à importer', 400, corsHeaders);

const stores = await getMagasinsServerSide();
const magasinsCodes = new Set(stores.map(s => s.code));

const parsed = [];
const rejected = [];
for (const row of rows) {
let code = row.code === null || row.code === undefined ? '' : String(row.code).trim();
if (KZ_IMPORT_ALIASES[code]) code = KZ_IMPORT_ALIASES[code];
const dateAudit = String(row.dateAudit || '').trim();
const score = Number(row.score);
const prenom = String(row.prenom || '').trim();

if (!code) { rejected.push({ code: row.code, dateAudit, prenom, score: row.score, raison: 'code magasin manquant' }); continue; }
if (!magasinsCodes.has(code)) { rejected.push({ code, dateAudit, prenom, score: row.score, raison: 'code magasin inconnu de magasins.csv' }); continue; }
const mois = /^\d{4}-\d{2}-\d{2}$/.test(dateAudit) ? dateAudit.slice(0, 7) : null;
if (!mois) { rejected.push({ code, dateAudit, prenom, score: row.score, raison: 'date invalide' }); continue; }
if (!Number.isFinite(score) || score < 0 || score > 50) { rejected.push({ code, mois, prenom, score: row.score, raison: 'score invalide' }); continue; }

parsed.push({ code, mois, score, prenom, dateAudit });
}

// Dédoublonnage (magasin, mois) : la ligne avec la date d'audit la plus
// récente est conservée (représente l'état le plus abouti de l'audit ce mois-là).
const byKey = new Map();
for (const p of parsed) {
const key = p.code + '|' + p.mois;
const existing = byKey.get(key);
if (!existing || p.dateAudit > existing.dateAudit) byKey.set(key, p);
}
const deduped = [...byKey.values()];

const { results: existingRows } = await env.DB.prepare(`SELECT magasin_code, mois FROM kaizen_audits`).all();
const existingKeys = new Set(existingRows.map(r => r.magasin_code + '|' + r.mois));

let inserted = 0, skippedExisting = 0;
const skippedDetails = [];
const stmts = [];
for (const p of deduped) {
const key = p.code + '|' + p.mois;
if (existingKeys.has(key)) { skippedExisting++; skippedDetails.push({ code: p.code, mois: p.mois }); continue; }
const itemsJson = JSON.stringify({ _imported: true, _source: 'historique_kaizen.xlsx', _controleur: p.prenom });
stmts.push(env.DB.prepare(
`INSERT INTO kaizen_audits (magasin_code, mois, items_json, score, score_max, closed, closed_at, imported)
VALUES (?, ?, ?, ?, 50, 1, datetime('now'), 1)`
).bind(p.code, p.mois, itemsJson, p.score));
inserted++;
}
for (let i = 0; i < stmts.length; i += 400) {
await env.DB.batch(stmts.slice(i, i + 400));
}

return new Response(JSON.stringify({
ok: true,
totalLignes: rows.length,
importables: parsed.length,
dedupliques: deduped.length,
inserted,
skippedExisting,
skippedDetails,
rejected,
}), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
} catch (e) {
return jsonError('Erreur import historique Kaizen : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-import-historique-rollback') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.DB) return jsonError('Base D1 non liée au Worker', 500, corsHeaders);
const sessionAr = await verifyArSession(request.headers.get('X-AR-Session'));
if (sessionAr !== 'ALL') return jsonError('Réservé à Olivier', 403, corsHeaders);

try {
const { results } = await env.DB.prepare(`SELECT COUNT(*) as n FROM kaizen_audits WHERE imported = 1`).all();
const count = results[0]?.n || 0;
await env.DB.prepare(`DELETE FROM kaizen_audits WHERE imported = 1`).run();
return new Response(JSON.stringify({ ok: true, deleted: count }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur suppression historique importé : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-photo' && request.method === 'POST') {
const storeToken = request.headers.get('X-Store-Token');
if (storeToken !== STORE_SECRET) return jsonError('Non autorisé', 401, corsHeaders);
if (!env.KAIZEN_PHOTOS) return jsonError('Bucket R2 non lié au Worker (KAIZEN_PHOTOS)', 500, corsHeaders);

const code = url.searchParams.get('code');
const key = url.searchParams.get('key');
if (!code || !key) return jsonError('Paramètres code et key requis', 400, corsHeaders);
if (!key.startsWith(code + '/')) return jsonError('Clé invalide', 400, corsHeaders);

try {
const bytes = await request.arrayBuffer();
if (bytes.byteLength === 0) return jsonError('Fichier vide', 400, corsHeaders);
const contentType = request.headers.get('Content-Type') || 'image/jpeg';
await env.KAIZEN_PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
return new Response(JSON.stringify({ ok: true, key }), {
status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (e) {
return jsonError('Erreur upload photo : ' + String(e), 500, corsHeaders);
}
}

if (url.pathname === '/kaizen-photo' && request.method === 'GET') {
if (!env.KAIZEN_PHOTOS) return jsonError('Bucket R2 non lié au Worker (KAIZEN_PHOTOS)', 500, corsHeaders);
const key = url.searchParams.get('key');
if (!key) return jsonError('Paramètre key requis', 400, corsHeaders);

const obj = await env.KAIZEN_PHOTOS.get(key);
if (!obj) return new Response('Introuvable', { status: 404, headers: corsHeaders });

return new Response(obj.body, {
status: 200,
headers: {
'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
'Cache-Control': 'public, max-age=300',
...corsHeaders,
},
});
}

// par défaut : relais SOAP (AuthRequest, SendMsgRequest, ...)
const body = await request.text();
const zimbraResponse = await fetch(ZIMBRA_SOAP_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body,
});
const text = await zimbraResponse.text();
return new Response(text, {
status: zimbraResponse.status,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
} catch (err) {
return new Response(JSON.stringify({ error: String(err) }), {
status: 502,
headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
}
},

async scheduled(event, env, ctx) {
const cron = event.cron;
if (cron === '0 14 * * SUN' || cron === '0 7 * * SUN') {
ctx.waitUntil(withCronAlert(env, 'Com hebdo', () => sendComHebdo(env)));
} else if (cron === '0 20 * * SUN' || cron === '0 22 * * SUN') {
ctx.waitUntil(withCronAlert(env, 'Purge hebdomadaire', () => purgeWeeklySources(env)));
} else if (cron === '0 6 * * SAT') {
ctx.waitUntil(withCronAlert(env, 'Bilan hebdomadaire', () => sendWeeklyReport(env)));
ctx.waitUntil(withCronAlert(env, 'Relance visite', () => sendVisitReminders(env)));
} else if (cron === '0 8 1 * *') {
ctx.waitUntil(withCronAlert(env, 'Bilan mensuel', () => sendMonthlyReport(env)));
ctx.waitUntil(withCronAlert(env, 'Export mensuel éval équipe', () => envoyerExportMensuelEval(env)));
ctx.waitUntil(withCronAlert(env, 'Clôture Kaizen', () => cloturerAuditsKaizen(env)));
ctx.waitUntil(withCronAlert(env, 'Rappel import RH', () => sendRhImportReminder(env)));
} else if (cron === '0 4 * * MON' || cron === '0 4 * * WED' || cron === '0 4 * * FRI') {
ctx.waitUntil(withCronAlert(env, 'Refresh Google ratings', () => refreshGoogleRatings(env)));
} else {
console.error('Cron non reconnu, aucune action déclenchée:', cron);
ctx.waitUntil(zimbraSendMail(env, {
to: OLIVIER_EMAIL,
subject: `⚠️ Cron non reconnu sur zimbra-relay`,
bodyText: `Le trigger "${cron}" a déclenché scheduled() mais ne correspond à aucun job connu dans le code.\n\nÀ vérifier : la configuration des Cron Triggers (Cloudflare Dashboard → zimbra-relay → Triggers) a peut-être changé sans que le code ait été mis à jour en conséquence.`,
}).catch(e => console.error('Échec envoi alerte cron non reconnu:', e)));
}
}
};