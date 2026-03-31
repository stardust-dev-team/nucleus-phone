#!/usr/bin/env node
/**
 * seed-equipment-specs.js — Seed equipment_catalog + equipment_details
 * with 80-120 entries covering CNC, packaging, paint, and woodworking.
 *
 * Idempotent: uses INSERT ... ON CONFLICT DO UPDATE.
 * Run: node scripts/seed-equipment-specs.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { pool } = require('../server/db');

// ── CNC Mills ───────────────────────────────────────────────────────

const CNC_MILLS = [
  // Haas vertical mills
  { manufacturer: 'Haas', model: 'Mini Mill', variants: ['MiniMill', 'Mini-Mill'], subcategory: 'vertical_mill', cfm_min: 5, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 60, hp: 7.5, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-1', variants: ['VF1', 'VF 1'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 65, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-2', variants: ['VF2', 'VF 2'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 70, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-2SS', variants: ['VF2SS', 'VF 2SS'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 20, cfm_typical: 14, psi: 90, duty: 70, hp: 30, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-3', variants: ['VF3', 'VF 3'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-4', variants: ['VF4', 'VF 4'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 25, cfm_typical: 16, psi: 90, duty: 70, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-5', variants: ['VF5', 'VF 5'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 18, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'VF-6', variants: ['VF6', 'VF 6'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 30, cfm_typical: 20, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'UMC-500', variants: ['UMC500', 'UMC 500'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 75, hp: 30, axes: 5, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'UMC-750', variants: ['UMC750', 'UMC 750'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 18, psi: 90, duty: 75, hp: 30, axes: 5, voltage: '208V/3ph', quality: 'general' },

  // Haas lathes
  { manufacturer: 'Haas', model: 'ST-10', variants: ['ST10', 'ST 10'], subcategory: 'turning_center', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 55, hp: 15, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Haas', model: 'ST-20', variants: ['ST20', 'ST 20'], subcategory: 'turning_center', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 60, hp: 20, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Haas', model: 'ST-30', variants: ['ST30', 'ST 30'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 60, hp: 25, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Haas', model: 'ST-35', variants: ['ST35', 'ST 35'], subcategory: 'turning_center', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 65, hp: 30, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },

  // Mazak
  { manufacturer: 'Mazak', model: 'QTN-100', variants: ['QTN100', 'QTN 100', 'Quick Turn Nexus 100'], subcategory: 'turning_center', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 55, hp: 15, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Mazak', model: 'QTN-200', variants: ['QTN200', 'QTN 200', 'Quick Turn Nexus 200'], subcategory: 'turning_center', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 60, hp: 20, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Mazak', model: 'QTN-250', variants: ['QTN250', 'QTN 250', 'Quick Turn Nexus 250'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 60, hp: 25, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Mazak', model: 'QTN-300', variants: ['QTN300', 'QTN 300', 'Quick Turn Nexus 300'], subcategory: 'turning_center', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 65, hp: 30, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Mazak', model: 'VTC-300C', variants: ['VTC300C', 'VTC 300C'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Mazak', model: 'INTEGREX i-200', variants: ['INTEGREX i200', 'Integrex 200'], subcategory: 'multi_tasking', cfm_min: 15, cfm_max: 28, cfm_typical: 20, psi: 90, duty: 75, hp: 30, axes: 5, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Mazak', model: 'INTEGREX i-300', variants: ['INTEGREX i300', 'Integrex 300'], subcategory: 'multi_tasking', cfm_min: 18, cfm_max: 32, cfm_typical: 22, psi: 90, duty: 75, hp: 40, axes: 5, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'Mazak', model: 'VCN-530C', variants: ['VCN530C', 'VCN 530C'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '220V/3ph', quality: 'general' },

  // DMG Mori
  { manufacturer: 'DMG Mori', model: 'NLX 2500', variants: ['NLX2500', 'NLX 2500/700'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 20, cfm_typical: 14, psi: 90, duty: 65, hp: 25, axes: 2, voltage: '480V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'DMG Mori', model: 'CMX 600V', variants: ['CMX600V', 'CMX 600'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 18, axes: 3, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'DMG Mori', model: 'CMX 800V', variants: ['CMX800V', 'CMX 800'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 25, cfm_typical: 18, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'DMG Mori', model: 'DMU 50', variants: ['DMU50'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 18, psi: 90, duty: 75, hp: 25, axes: 5, voltage: '480V/3ph', quality: 'general' },

  // Okuma
  { manufacturer: 'Okuma', model: 'GENOS L200', variants: ['GENOS L 200', 'L200'], subcategory: 'turning_center', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 60, hp: 15, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Okuma', model: 'GENOS L300', variants: ['GENOS L 300', 'L300'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 60, hp: 20, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Okuma', model: 'GENOS M460', variants: ['GENOS M 460', 'M460'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 65, hp: 20, axes: 3, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Okuma', model: 'GENOS M560', variants: ['GENOS M 560', 'M560'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 65, hp: 25, axes: 3, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Okuma', model: 'LB3000 EX II', variants: ['LB3000', 'LB 3000', 'LB3000EX'], subcategory: 'turning_center', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 65, hp: 30, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },

  // Doosan
  { manufacturer: 'Doosan', model: 'DNM 4500', variants: ['DNM4500', 'DNM 4500P'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 65, hp: 20, axes: 3, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Doosan', model: 'DNM 5700', variants: ['DNM5700', 'DNM 5700P'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Doosan', model: 'DVF 5000', variants: ['DVF5000', 'DVF 5000T'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 25, cfm_typical: 18, psi: 90, duty: 75, hp: 25, axes: 5, voltage: '220V/3ph', quality: 'general' },
  { manufacturer: 'Doosan', model: 'Lynx 2100', variants: ['Lynx2100', 'Lynx 2100LM'], subcategory: 'turning_center', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 55, hp: 15, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Doosan', model: 'Puma 2600', variants: ['Puma2600', 'Puma 2600SY'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 60, hp: 25, axes: 2, voltage: '220V/3ph', quality: 'general', category: 'cnc_lathe' },

  // Fanuc
  { manufacturer: 'Fanuc', model: 'ROBODRILL a-D21MiB5', variants: ['ROBODRILL', 'Robodrill D21', 'D21MiB5'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 70, hp: 10.7, axes: 5, voltage: '200V/3ph', quality: 'general' },
  { manufacturer: 'Fanuc', model: 'ROBODRILL a-D21LiB5', variants: ['Robodrill D21L', 'D21LiB5'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 70, hp: 10.7, axes: 5, voltage: '200V/3ph', quality: 'general' },

  // Hurco
  { manufacturer: 'Hurco', model: 'VM10i', variants: ['VM10', 'VM 10i', 'VM-10i'], subcategory: 'vertical_mill', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 60, hp: 12, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Hurco', model: 'VM20i', variants: ['VM20', 'VM 20i', 'VM-20i'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 65, hp: 15, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Hurco', model: 'VM30i', variants: ['VM30', 'VM 30i', 'VM-30i'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 65, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Hurco', model: 'VMX30i', variants: ['VMX30', 'VMX 30i'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 20, cfm_typical: 14, psi: 90, duty: 70, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Hurco', model: 'VMX42i', variants: ['VMX42', 'VMX 42i'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '208V/3ph', quality: 'general' },

  // Kitamura
  { manufacturer: 'Kitamura', model: 'Mycenter-3XiF', variants: ['Mycenter 3XiF', 'Mycenter3XiF', 'Mycenter 3X'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 65, hp: 15, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Kitamura', model: 'Mycenter-4XiF', variants: ['Mycenter 4XiF', 'Mycenter4XiF', 'Mycenter 4X'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 65, hp: 20, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Kitamura', model: 'Mycenter-HX400iG', variants: ['HX400iG', 'Mycenter HX400'], subcategory: 'horizontal_mill', cfm_min: 15, cfm_max: 25, cfm_typical: 18, psi: 90, duty: 75, hp: 25, axes: 4, voltage: '208V/3ph', quality: 'general' },

  // Bridgeport (older shops still running these)
  { manufacturer: 'Bridgeport', model: 'Series I', variants: ['Series 1', 'Bridgeport Mill'], subcategory: 'vertical_mill', cfm_min: 2, cfm_max: 5, cfm_typical: 3, psi: 90, duty: 40, hp: 2, axes: 3, voltage: '208V/1ph', quality: 'general' },
];

// ── Packaging Equipment ─────────────────────────────────────────────

const PACKAGING = [
  { manufacturer: 'Pearson', model: 'CE25', variants: ['CE-25', 'CE 25'], category: 'packaging', subcategory: 'case_erector', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 80, duty: 80, hp: null, axes: null, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Pearson', model: 'CE25T', variants: ['CE-25T', 'CE 25T'], category: 'packaging', subcategory: 'case_erector', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 80, duty: 80, hp: null, axes: null, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Pearson', model: 'CE35', variants: ['CE-35', 'CE 35'], category: 'packaging', subcategory: 'case_erector', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 80, duty: 85, hp: null, axes: null, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Pearson', model: 'CE50', variants: ['CE-50', 'CE 50'], category: 'packaging', subcategory: 'case_erector', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 80, duty: 85, hp: null, axes: null, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Pearson', model: 'N401', variants: ['N-401', 'N 401'], category: 'packaging', subcategory: 'case_sealer', cfm_min: 5, cfm_max: 10, cfm_typical: 7, psi: 80, duty: 75, hp: null, axes: null, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Wexxar', model: 'WF20', variants: ['WF-20', 'WF 20', 'BEL WF20'], category: 'packaging', subcategory: 'case_erector', cfm_min: 8, cfm_max: 14, cfm_typical: 10, psi: 80, duty: 80, hp: null, axes: null, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Wexxar', model: 'WF30', variants: ['WF-30', 'WF 30', 'BEL WF30'], category: 'packaging', subcategory: 'case_erector', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 80, duty: 80, hp: null, axes: null, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Loveshaw', model: 'LDX-RTB', variants: ['LDX RTB', 'LDXRTB', 'LDX'], category: 'packaging', subcategory: 'case_sealer', cfm_min: 3, cfm_max: 8, cfm_typical: 5, psi: 80, duty: 70, hp: null, axes: null, voltage: '115V/1ph', quality: 'general' },
  { manufacturer: 'Combi', model: 'CE-25', variants: ['CE25', 'Combi CE25'], category: 'packaging', subcategory: 'case_erector', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 80, duty: 80, hp: null, axes: null, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Lantech', model: 'Q-300', variants: ['Q300', 'Q 300'], category: 'packaging', subcategory: 'stretch_wrapper', cfm_min: 4, cfm_max: 8, cfm_typical: 5, psi: 80, duty: 60, hp: null, axes: null, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Signode', model: 'SPIRIT', variants: ['Spirit', 'Signode Spirit'], category: 'packaging', subcategory: 'strapping', cfm_min: 5, cfm_max: 10, cfm_typical: 6, psi: 80, duty: 65, hp: null, axes: null, voltage: '115V/1ph', quality: 'general' },
];

// ── Paint / Collision Equipment ─────────────────────────────────────

const PAINT = [
  // HVLP spray guns — air demand scales with orifice size
  { manufacturer: 'SATA', model: 'SATAjet 5000 B 1.3', variants: ['SATAjet 5000', 'SATA 5000', 'SATAjet 1.3'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 10, cfm_max: 16, cfm_typical: 13, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'SATA', model: 'SATAjet 5000 B 1.4', variants: ['SATA 5000 1.4', 'SATAjet 1.4'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 11, cfm_max: 18, cfm_typical: 14.5, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'SATA', model: 'SATAjet X 5500 1.3', variants: ['SATAjet X 5500', 'SATA X5500'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 10, cfm_max: 16, cfm_typical: 12, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'DeVilbiss', model: 'GTi Pro Lite 1.3', variants: ['GTi Pro', 'DeVilbiss GTi', 'GTi Pro Lite'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 9, cfm_max: 15, cfm_typical: 12, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'DeVilbiss', model: 'GTi Pro Lite 1.4', variants: ['GTi Pro 1.4', 'DeVilbiss 1.4'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 10, cfm_max: 17, cfm_typical: 13.5, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'DeVilbiss', model: 'FLG-5', variants: ['FLG5', 'FLG 5', 'Finishline'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 7, cfm_max: 12, cfm_typical: 9, psi: 50, duty: 55, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'Iwata', model: 'LPH-400 1.3', variants: ['LPH400', 'LPH 400', 'Iwata LPH'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 8, cfm_max: 14, cfm_typical: 11, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'Iwata', model: 'LPH-400 1.4', variants: ['LPH400 1.4', 'Iwata 1.4'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 9, cfm_max: 15, cfm_typical: 12.5, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },
  { manufacturer: 'Iwata', model: 'W-400 1.4', variants: ['W400', 'W 400', 'Iwata W400'], category: 'paint', subcategory: 'hvlp_gun', cfm_min: 10, cfm_max: 16, cfm_typical: 13, psi: 29, duty: 60, hp: null, axes: null, voltage: null, quality: 'paint_grade' },

  // DA Sanders
  { manufacturer: 'Dynabrade', model: '56825', variants: ['Dynabrade 6in', 'Dynabrade DA'], category: 'paint', subcategory: 'da_sander', cfm_min: 12, cfm_max: 20, cfm_typical: 16, psi: 90, duty: 70, hp: null, axes: null, voltage: null, quality: 'general' },
  { manufacturer: 'Dynabrade', model: '56830', variants: ['Dynabrade 5in'], category: 'paint', subcategory: 'da_sander', cfm_min: 10, cfm_max: 18, cfm_typical: 14, psi: 90, duty: 70, hp: null, axes: null, voltage: null, quality: 'general' },
  { manufacturer: '3M', model: 'Elite Series DA', variants: ['3M DA', '3M Elite DA', '3M sander'], category: 'paint', subcategory: 'da_sander', cfm_min: 10, cfm_max: 18, cfm_typical: 14, psi: 90, duty: 65, hp: null, axes: null, voltage: null, quality: 'general' },

  // Sandblasters
  { manufacturer: 'Clemco', model: '1028', variants: ['Clemco 1028', 'Clemco 1 cuft'], category: 'paint', subcategory: 'sandblaster', cfm_min: 80, cfm_max: 200, cfm_typical: 140, psi: 100, duty: 50, hp: null, axes: null, voltage: null, quality: 'general' },
  { manufacturer: 'Clemco', model: '2452', variants: ['Clemco 2452', 'Clemco 2 cuft'], category: 'paint', subcategory: 'sandblaster', cfm_min: 80, cfm_max: 250, cfm_typical: 160, psi: 100, duty: 50, hp: null, axes: null, voltage: null, quality: 'general' },
  { manufacturer: 'Schmidt', model: 'Axxiom 12/6', variants: ['Axxiom', 'Schmidt Axxiom', 'Schmidt blaster'], category: 'paint', subcategory: 'sandblaster', cfm_min: 60, cfm_max: 180, cfm_typical: 120, psi: 100, duty: 50, hp: null, axes: null, voltage: null, quality: 'general' },

  // Spray booth air makeup
  { manufacturer: 'Global Finishing', model: 'GFS Spray Booth', variants: ['GFS booth', 'Global Finishing booth'], category: 'paint', subcategory: 'spray_booth', cfm_min: 3, cfm_max: 8, cfm_typical: 5, psi: 80, duty: 90, hp: null, axes: null, voltage: '208V/3ph', quality: 'paint_grade' },
  { manufacturer: 'Col-Met', model: 'Spray Booth', variants: ['Col-Met booth', 'ColMet'], category: 'paint', subcategory: 'spray_booth', cfm_min: 3, cfm_max: 8, cfm_typical: 5, psi: 80, duty: 90, hp: null, axes: null, voltage: '208V/3ph', quality: 'paint_grade' },
];

// ── Woodworking Equipment ───────────────────────────────────────────

const WOODWORKING = [
  { manufacturer: 'ShopBot', model: 'PRSalpha', variants: ['PRS alpha', 'PRS Alpha', 'Shopbot PRS'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 60, hp: 3.25, axes: 3, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'ShopBot', model: 'PRSstandard', variants: ['PRS Standard', 'PRS standard', 'Shopbot Standard'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 4, cfm_max: 10, cfm_typical: 6, psi: 90, duty: 55, hp: 2.2, axes: 3, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'ShopBot', model: 'Buddy', variants: ['Desktop Buddy', 'Shopbot Buddy'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 2, cfm_max: 6, cfm_typical: 3, psi: 90, duty: 45, hp: 1.5, axes: 3, voltage: '115V/1ph', quality: 'general' },
  { manufacturer: 'Laguna', model: 'SmartShop II', variants: ['SmartShop 2', 'SmartShop', 'Laguna SmartShop'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 6, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 60, hp: 5, axes: 3, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Laguna', model: 'SmartShop III', variants: ['SmartShop 3', 'Laguna SmartShop 3'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 65, hp: 7.5, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Laguna', model: 'Swift', variants: ['Laguna Swift'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 3, cfm_max: 8, cfm_typical: 5, psi: 90, duty: 50, hp: 2.2, axes: 3, voltage: '208V/1ph', quality: 'general' },
  { manufacturer: 'Thermwood', model: 'Model 43', variants: ['Thermwood 43', 'Model43'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 65, hp: 10, axes: 3, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Thermwood', model: 'Model 53', variants: ['Thermwood 53', 'Model53'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 10, cfm_max: 20, cfm_typical: 14, psi: 90, duty: 70, hp: 15, axes: 5, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'Thermwood', model: 'Model 67', variants: ['Thermwood 67', 'Model67'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 12, cfm_max: 25, cfm_typical: 16, psi: 90, duty: 70, hp: 15, axes: 5, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'Biesse', model: 'Rover A', variants: ['Rover', 'Biesse Rover', 'Rover A Edge'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 65, hp: 12, axes: 5, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'Grizzly', model: 'G0893', variants: ['G0893', 'Grizzly CNC'], category: 'woodworking', subcategory: 'cnc_router', cfm_min: 2, cfm_max: 5, cfm_typical: 3, psi: 90, duty: 40, hp: 1.5, axes: 3, voltage: '115V/1ph', quality: 'general' },

  // Pneumatic woodworking tools
  { manufacturer: 'Senco', model: 'FinishPro 42XP', variants: ['FinishPro', 'Senco nailer', '42XP'], category: 'woodworking', subcategory: 'pneumatic_nailer', cfm_min: 1, cfm_max: 3, cfm_typical: 2, psi: 100, duty: 30, hp: null, axes: null, voltage: null, quality: 'general' },
];

// ── Equipment Details (CAS selling context) ─────────────────────────

const DETAILS = {
  'Haas:VF-2': {
    description: 'Most popular Haas vertical mill — workhorse of job shops. High tool-change frequency drives intermittent air demand.',
    typical_applications: ['job shop', 'prototyping', 'production milling'],
    industries: ['aerospace', 'automotive', 'medical', 'general manufacturing'],
    air_usage_notes: 'Tool change, chip blow-off, air-operated vise clamps. Higher CFM during rapid tool changes.',
    common_air_problems: ['moisture in tool holder causing rust', 'pressure drops during simultaneous tool change and vise clamp'],
    recommended_air_quality: 'Dried air mandatory — moisture causes tool holder corrosion and bearing damage',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'RD40-115',
    system_notes: 'Single VF-2: JRS-7.5E adequate. Multiple machines: JRS-10E or JRS-15E.',
    key_selling_points: ['Haas shops often add machines — size the system for growth', 'Moisture is the #1 maintenance issue for Haas tool holders'],
    common_objections: ['Already have a piston compressor', 'Getting quotes from Kaeser/Atlas Copco'],
  },
  'Haas:VF-4': {
    description: 'Large-envelope Haas vertical mill. Longer tool changer cycle, more fixtures = more air demand per cycle.',
    typical_applications: ['large parts', 'mold work', 'production'],
    industries: ['aerospace', 'mold making', 'heavy equipment'],
    air_usage_notes: 'Larger work envelope means more blow-off air. Often paired with 4th axis rotary = additional pneumatic clamping.',
    common_air_problems: ['undersized compressor from shop expansion', 'oil in air damaging paint finishes'],
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'RD75-115',
    system_notes: 'Shops with VF-4+ usually have 3-5 machines total. Size for the shop, not the machine.',
  },
  'Mazak:INTEGREX i-200': {
    description: 'Multi-tasking mill-turn center. Continuous air demand for live tooling, sub-spindle, and chip management.',
    typical_applications: ['complex parts', 'done-in-one machining'],
    industries: ['aerospace', 'medical', 'oil and gas'],
    air_usage_notes: 'Higher continuous demand than standard lathe due to milling operations. Chip conveyor often pneumatic.',
    common_air_problems: ['insufficient CFM for simultaneous milling and turning air needs'],
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'RD75-115',
    system_notes: 'INTEGREX shops are high-end — sell on air quality, not just volume.',
  },
  'Pearson:CE25': {
    description: 'Compact case erector for 5-25 CPM lines. Continuous high duty cycle during production runs.',
    typical_applications: ['food and beverage packaging', 'consumer goods', 'e-commerce fulfillment'],
    industries: ['food and beverage', 'consumer products', 'logistics'],
    air_usage_notes: 'Continuous air use during production. Multiple machines on a line compound demand quickly.',
    common_air_problems: ['pressure drops causing missed case folds', 'moisture causing tape gun failures'],
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'RD40-115',
    system_notes: 'Packaging lines often have 3-5 pneumatic machines. Size for the whole line.',
  },
  'SATA:SATAjet 5000 B 1.3': {
    description: 'Premium HVLP spray gun — the standard in high-end collision and refinish work.',
    typical_applications: ['automotive refinish', 'collision repair', 'custom paint'],
    industries: ['collision repair', 'automotive refinish', 'custom fabrication'],
    air_usage_notes: 'HVLP guns demand high volume at LOW pressure (29 PSI at cap). Total system needs to deliver volume, not just pressure.',
    common_air_problems: ['moisture/oil in air causing fish-eyes in paint', 'undersized compressor cannot sustain spray pattern', 'pressure drop through long hose runs'],
    recommended_air_quality: 'Paint-grade air mandatory — ISO 8573 Class 1 for moisture and oil',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'RD40-115',
    system_notes: 'Most body shops run 2-3 guns simultaneously. Size for peak booth usage. Always include coalescing filter.',
    key_selling_points: ['Fish-eyes = rework = $$. Clean dry air pays for itself', 'Painters know when air quality is bad — they will advocate internally'],
    common_objections: ['Expensive filter replacements', 'Already have a desiccant dryer'],
  },
  'Clemco:1028': {
    description: 'Portable 1 cuft sandblaster. Extremely high air demand — typically the biggest air consumer in any shop.',
    typical_applications: ['surface preparation', 'rust removal', 'coating removal'],
    industries: ['structural steel', 'marine', 'industrial maintenance'],
    air_usage_notes: 'CFM demand depends on nozzle size: #4 nozzle = 80 CFM, #6 = 140 CFM, #8 = 230 CFM. Most shops undersize by 50%.',
    common_air_problems: ['compressor cannot keep up — pressure drops below effective blasting range', 'moisture causes media clumping'],
    recommended_compressor: 'JRS-25E',
    system_notes: 'Single compressor often insufficient for #6+ nozzles. May need dedicated unit or parallel setup.',
    key_selling_points: ['Biggest air ROI in the shop — proper sizing cuts blast time in half', 'Most sandblasters are running 30-40% below optimal pressure'],
  },
  'ShopBot:PRSalpha': {
    description: 'Full-size CNC router for cabinet/sign shops. Intermittent air for tool change and hold-down clamps.',
    typical_applications: ['cabinet making', 'sign making', 'furniture', 'architectural millwork'],
    industries: ['woodworking', 'signage', 'custom furniture'],
    air_usage_notes: 'Vacuum hold-down is separate from compressed air. Air needed for ATC tool change and pneumatic clamps only.',
    common_air_problems: ['using shop air for both CNC and finish nailers — pressure fights'],
    recommended_compressor: 'JRS-7.5E',
    recommended_dryer: 'RD40-115',
    system_notes: 'Many wood shops can get by with JRS-7.5E unless running extensive pneumatic tooling.',
  },
};

// ── Seed Logic ──────────────────────────────────────────────────────

function buildCatalogRow(item) {
  return {
    manufacturer: item.manufacturer,
    model: item.model,
    model_variants: item.variants,
    category: item.category || 'cnc_mill',
    subcategory: item.subcategory,
    cfm_min: item.cfm_min,
    cfm_max: item.cfm_max,
    cfm_typical: item.cfm_typical,
    psi_required: item.psi,
    duty_cycle_pct: item.duty,
    air_quality_class: item.quality,
    axis_count: item.axes,
    power_hp: item.hp,
    voltage: item.voltage,
    source: 'expert_input',
    confidence: 'medium',
    verified_by: 'system',
  };
}

async function seed() {
  const allEquipment = [...CNC_MILLS, ...PACKAGING, ...PAINT, ...WOODWORKING];
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let detailsCount = 0;

  try {
    await client.query('BEGIN');

    for (const item of allEquipment) {
      const cat = buildCatalogRow(item);

      const { rows: [row] } = await client.query(
        `INSERT INTO equipment_catalog
          (manufacturer, model, model_variants, category, subcategory,
           cfm_min, cfm_max, cfm_typical, psi_required, duty_cycle_pct,
           air_quality_class, axis_count, power_hp, voltage,
           source, confidence, verified_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (manufacturer, model) DO UPDATE SET
           model_variants = EXCLUDED.model_variants,
           cfm_min = EXCLUDED.cfm_min,
           cfm_max = EXCLUDED.cfm_max,
           cfm_typical = EXCLUDED.cfm_typical,
           psi_required = EXCLUDED.psi_required,
           duty_cycle_pct = EXCLUDED.duty_cycle_pct,
           air_quality_class = EXCLUDED.air_quality_class,
           axis_count = EXCLUDED.axis_count,
           power_hp = EXCLUDED.power_hp,
           voltage = EXCLUDED.voltage,
           source = EXCLUDED.source,
           confidence = EXCLUDED.confidence,
           verified_by = EXCLUDED.verified_by,
           updated_at = NOW()
         RETURNING id, (xmax = 0) AS is_insert`,
        [
          cat.manufacturer, cat.model, cat.model_variants, cat.category,
          cat.subcategory, cat.cfm_min, cat.cfm_max, cat.cfm_typical,
          cat.psi_required, cat.duty_cycle_pct, cat.air_quality_class,
          cat.axis_count, cat.power_hp, cat.voltage, cat.source,
          cat.confidence, cat.verified_by,
        ]
      );

      if (row.is_insert) inserted++;
      else updated++;

      // Insert details if available
      const key = `${item.manufacturer}:${item.model}`;
      const details = DETAILS[key];
      if (details) {
        await client.query(
          `INSERT INTO equipment_details
            (equipment_id, description, typical_applications, industries,
             air_usage_notes, common_air_problems, recommended_air_quality,
             recommended_compressor, recommended_dryer, recommended_filters,
             system_notes, key_selling_points, common_objections)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (equipment_id) DO UPDATE SET
             description = EXCLUDED.description,
             typical_applications = EXCLUDED.typical_applications,
             industries = EXCLUDED.industries,
             air_usage_notes = EXCLUDED.air_usage_notes,
             common_air_problems = EXCLUDED.common_air_problems,
             recommended_air_quality = EXCLUDED.recommended_air_quality,
             recommended_compressor = EXCLUDED.recommended_compressor,
             recommended_dryer = EXCLUDED.recommended_dryer,
             recommended_filters = EXCLUDED.recommended_filters,
             system_notes = EXCLUDED.system_notes,
             key_selling_points = EXCLUDED.key_selling_points,
             common_objections = EXCLUDED.common_objections`,
          [
            row.id, details.description,
            details.typical_applications || null, details.industries || null,
            details.air_usage_notes || null, details.common_air_problems || null,
            details.recommended_air_quality || null, details.recommended_compressor || null,
            details.recommended_dryer || null, details.recommended_filters || null,
            details.system_notes || null, details.key_selling_points || null,
            details.common_objections || null,
          ]
        );
        detailsCount++;
      }
    }

    await client.query('COMMIT');
    console.log(`Seed complete: ${inserted} inserted, ${updated} updated, ${detailsCount} details records`);
    console.log(`Total entries: ${allEquipment.length}`);

    // Verification
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM equipment_catalog');
    console.log(`equipment_catalog total rows: ${count}`);

    const { rows: categories } = await pool.query(
      'SELECT category, COUNT(*)::int AS count FROM equipment_catalog GROUP BY category ORDER BY category'
    );
    console.log('By category:', categories.map(r => `${r.category}: ${r.count}`).join(', '));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
