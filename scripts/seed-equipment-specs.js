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
  { manufacturer: 'DMG Mori', model: 'NLX 2500', variants: ['NLX2500', 'NLX 2500/700', 'Mori Seiki NLX 2500', 'Mori Seiki NLX2500'], subcategory: 'turning_center', cfm_min: 10, cfm_max: 20, cfm_typical: 14, psi: 90, duty: 65, hp: 25, axes: 2, voltage: '480V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'DMG Mori', model: 'CMX 600V', variants: ['CMX600V', 'CMX 600', 'Mori Seiki CMX 600V'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 18, axes: 3, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'DMG Mori', model: 'CMX 800V', variants: ['CMX800V', 'CMX 800', 'Mori Seiki CMX 800V'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 25, cfm_typical: 18, psi: 90, duty: 70, hp: 25, axes: 3, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'DMG Mori', model: 'DMU 50', variants: ['DMU50', 'Mori Seiki DMU 50'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 18, psi: 90, duty: 75, hp: 25, axes: 5, voltage: '480V/3ph', quality: 'general' },

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

  // Haas HMCs — pallet changers are big air consumers
  { manufacturer: 'Haas', model: 'EC-400', variants: ['EC400', 'EC 400'], subcategory: 'horizontal_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 20, psi: 90, duty: 75, hp: 20, axes: 4, voltage: '208V/3ph', quality: 'general' },
  { manufacturer: 'Haas', model: 'EC-500', variants: ['EC500', 'EC 500'], subcategory: 'horizontal_mill', cfm_min: 18, cfm_max: 32, cfm_typical: 22, psi: 90, duty: 75, hp: 25, axes: 4, voltage: '208V/3ph', quality: 'general' },

  // Haas toolroom lathes — very common in small shops
  { manufacturer: 'Haas', model: 'TL-1', variants: ['TL1', 'TL 1'], subcategory: 'turning_center', cfm_min: 4, cfm_max: 10, cfm_typical: 6, psi: 90, duty: 45, hp: 7.5, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },
  { manufacturer: 'Haas', model: 'TL-2', variants: ['TL2', 'TL 2'], subcategory: 'turning_center', cfm_min: 5, cfm_max: 12, cfm_typical: 8, psi: 90, duty: 50, hp: 10, axes: 2, voltage: '208V/3ph', quality: 'general', category: 'cnc_lathe' },

  // Brother Speedio — very popular in production
  { manufacturer: 'Brother', model: 'Speedio S500X2', variants: ['S500X2', 'Speedio S500', 'Brother S500'], subcategory: 'vertical_mill', cfm_min: 8, cfm_max: 15, cfm_typical: 10, psi: 90, duty: 70, hp: 7, axes: 3, voltage: '200V/3ph', quality: 'general' },
  { manufacturer: 'Brother', model: 'Speedio S700X2', variants: ['S700X2', 'Speedio S700', 'Brother S700'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 70, hp: 11, axes: 3, voltage: '200V/3ph', quality: 'general' },
  { manufacturer: 'Brother', model: 'Speedio R650X2', variants: ['R650X2', 'Speedio R650', 'Brother R650'], subcategory: 'vertical_mill', cfm_min: 10, cfm_max: 18, cfm_typical: 12, psi: 90, duty: 75, hp: 11, axes: 5, voltage: '200V/3ph', quality: 'general' },

  // Mazak 5-axis
  { manufacturer: 'Mazak', model: 'VARIAXIS i-300', variants: ['VARIAXIS i300', 'Variaxis 300'], subcategory: 'vertical_mill', cfm_min: 15, cfm_max: 28, cfm_typical: 18, psi: 90, duty: 75, hp: 25, axes: 5, voltage: '220V/3ph', quality: 'general' },

  // Doosan HMC
  { manufacturer: 'Doosan', model: 'NHP 5000', variants: ['NHP5000', 'NHP 5000'], subcategory: 'horizontal_mill', cfm_min: 18, cfm_max: 30, cfm_typical: 22, psi: 90, duty: 75, hp: 30, axes: 4, voltage: '220V/3ph', quality: 'general' },

  // Makino — high-end production
  { manufacturer: 'Makino', model: 'PS95', variants: ['PS 95', 'PS95'], subcategory: 'vertical_mill', cfm_min: 12, cfm_max: 22, cfm_typical: 15, psi: 90, duty: 70, hp: 20, axes: 3, voltage: '480V/3ph', quality: 'general' },
  { manufacturer: 'Makino', model: 'a51nx', variants: ['a51', 'a51 nx', 'Makino a51'], subcategory: 'horizontal_mill', cfm_min: 18, cfm_max: 30, cfm_typical: 22, psi: 90, duty: 80, hp: 30, axes: 4, voltage: '480V/3ph', quality: 'general' },
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
    recommended_dryer: 'JRD-40',
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
    recommended_dryer: 'JRD-80',
    system_notes: 'Shops with VF-4+ usually have 3-5 machines total. Size for the shop, not the machine.',
    key_selling_points: ['VF-4 shops almost always have a 4th axis rotary — that\'s another air consumer most people forget to size for', 'These shops outgrew their compressor two machines ago. They just haven\'t admitted it yet.'],
    common_objections: ['We\'ve been running fine for years', 'We\'ll deal with it when we add the next machine'],
  },
  'Mazak:INTEGREX i-200': {
    description: 'Multi-tasking mill-turn center. Continuous air demand for live tooling, sub-spindle, and chip management.',
    typical_applications: ['complex parts', 'done-in-one machining'],
    industries: ['aerospace', 'medical', 'oil and gas'],
    air_usage_notes: 'Higher continuous demand than standard lathe due to milling operations. Chip conveyor often pneumatic.',
    common_air_problems: ['insufficient CFM for simultaneous milling and turning air needs'],
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'INTEGREX shops are high-end — sell on air quality, not just volume.',
    key_selling_points: ['An INTEGREX does the work of a mill and a lathe — your air system needs to handle both simultaneously', 'Done-in-one machining means zero tolerance for air interruptions mid-cycle. One pressure drop scraps a part that\'s had 40 minutes of work.'],
    common_objections: ['Mazak specs say 90 PSI and we have that', 'Our machine runs fine'],
  },
  'Pearson:CE25': {
    description: 'Compact case erector for 5-25 CPM lines. Continuous high duty cycle during production runs.',
    typical_applications: ['food and beverage packaging', 'consumer goods', 'e-commerce fulfillment'],
    industries: ['food and beverage', 'consumer products', 'logistics'],
    air_usage_notes: 'Continuous air use during production. Multiple machines on a line compound demand quickly.',
    common_air_problems: ['pressure drops causing missed case folds', 'moisture causing tape gun failures'],
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Packaging lines often have 3-5 pneumatic machines. Size for the whole line.',
    key_selling_points: ['A missed case fold stops the whole line — not just one machine', 'Packaging lines add equipment constantly. Size the air system for next year\'s throughput target, not today\'s.'],
    common_objections: ['The line builder spec\'d the compressor', 'We only run one shift'],
  },
  'SATA:SATAjet 5000 B 1.3': {
    description: 'Premium HVLP spray gun — the standard in high-end collision and refinish work.',
    typical_applications: ['automotive refinish', 'collision repair', 'custom paint'],
    industries: ['collision repair', 'automotive refinish', 'custom fabrication'],
    air_usage_notes: 'HVLP guns demand high volume at LOW pressure (29 PSI at cap). Total system needs to deliver volume, not just pressure.',
    common_air_problems: ['moisture/oil in air causing fish-eyes in paint', 'undersized compressor cannot sustain spray pattern', 'pressure drop through long hose runs'],
    recommended_air_quality: 'Paint-grade air mandatory — ISO 8573 Class 1 for moisture and oil',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Most body shops run 2-3 guns simultaneously. Size for peak booth usage. Always include coalescing filter.',
    key_selling_points: ['Fish-eyes = rework = $$. Clean dry air pays for itself', 'Painters know when air quality is bad — they will advocate internally'],
    common_objections: ['Expensive filter replacements', 'Already have a desiccant dryer'],
  },
  'Clemco:1028': {
    description: 'Portable 1 cuft sandblaster. Extremely high air demand — typically the biggest air consumer in any shop.',
    typical_applications: ['surface preparation', 'rust removal', 'coating removal'],
    industries: ['structural steel', 'marine', 'industrial maintenance'],
    air_usage_notes: 'CFM demand depends on nozzle size: #4 nozzle = 80 CFM, #6 = 140 CFM, #8 = 230 CFM. Most shops undersize by 50%.',
    common_air_problems: ['compressor cannot keep up — pressure drops below effective blasting range', 'moisture causes media clumping and nozzle clogging'],
    recommended_air_quality: 'Dry air mandatory — moisture causes media clumping, nozzle blockage, and flash rust on blasted surfaces',
    recommended_compressor: 'JRS-25E',
    recommended_dryer: 'JRD-200',
    system_notes: 'Single compressor often insufficient for #6+ nozzles. May need dedicated unit or parallel setup. Always pair with dryer — wet blasting is the #1 complaint.',
    key_selling_points: ['Biggest air ROI in the shop — proper sizing cuts blast time in half', 'Most sandblasters are running 30-40% below optimal pressure', 'Dry air eliminates flash rust rework'],
    common_objections: ['We only blast a few times a month', 'We rent a diesel compressor when we need to blast'],
  },
  'ShopBot:PRSalpha': {
    description: 'Full-size CNC router for cabinet/sign shops. Intermittent air for tool change and hold-down clamps.',
    typical_applications: ['cabinet making', 'sign making', 'furniture', 'architectural millwork'],
    industries: ['woodworking', 'signage', 'custom furniture'],
    air_usage_notes: 'Vacuum hold-down is separate from compressed air. Air needed for ATC tool change and pneumatic clamps only.',
    common_air_problems: ['using shop air for both CNC and finish nailers — pressure fights'],
    recommended_compressor: 'JRS-7.5E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Many wood shops can get by with JRS-7.5E unless running extensive pneumatic tooling.',
    key_selling_points: ['Wood dust and moisture in the same air line kills pneumatic tools fast — a dryer pays for itself in nailer replacements alone', 'CNC router plus a crew running finish nailers? That\'s two different air profiles fighting over one pipe.'],
    common_objections: ['We just use a small shop compressor', 'Woodworking doesn\'t need industrial air'],
  },

  // ── Additional equipment details (expanding to top 20) ──

  'Haas:Mini Mill': {
    description: 'Entry-level Haas vertical mill. Huge install base — schools, startups, and small job shops. Low air demand but shops often add machines fast.',
    typical_applications: ['prototyping', 'small parts', 'education', 'low-volume production'],
    industries: ['education', 'aerospace', 'medical', 'job shop'],
    air_usage_notes: 'Modest air for tool change and optional air blast. Many Mini Mill shops run a piston compressor — an easy upgrade sale.',
    common_air_problems: ['running a consumer-grade piston compressor that overheats on 2nd shift', 'no dryer — moisture accumulating in tool holder tapers'],
    recommended_air_quality: 'Dried air recommended — prevents taper corrosion even at low volumes',
    recommended_compressor: 'JRS-7.5E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Mini Mill is often the first CNC purchase. These shops grow fast — a JRS-10E future-proofs the inevitable second machine.',
    key_selling_points: ['Mini Mill shops are growing shops — size for where they\'re going, not where they are', 'Upgrading from a piston compressor cuts noise and maintenance immediately'],
    common_objections: ['We only have one machine, can\'t justify the cost', 'Our piston compressor works fine'],
  },
  'Haas:ST-20': {
    description: 'Most popular Haas turning center. Workhorse lathe found in nearly every Haas job shop. Steady air demand for chuck, tailstock, and chip management.',
    typical_applications: ['shaft work', 'production turning', 'job shop'],
    industries: ['automotive', 'oil and gas', 'general manufacturing', 'aerospace'],
    air_usage_notes: 'Pneumatic chuck and tailstock cycling. Chip blow-off between operations. Sub-spindle models (ST-20Y) add another air consumer.',
    common_air_problems: ['moisture in chuck mechanism causing inconsistent clamping force', 'pressure drops when chuck cycles coincide with bar feeder indexing'],
    recommended_air_quality: 'Dried air mandatory — moisture degrades chuck seals and causes part ejection inconsistency',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'ST-20 shops almost always have mills too. Size the system for the whole shop. If they have a bar feeder, add 3-5 CFM.',
    key_selling_points: ['Chuck seal failures from wet air cost more in downtime than a dryer costs', 'Shops with ST-20s usually have 3-5 machines total — quote the system, not the machine'],
    common_objections: ['Our lathe doesn\'t use that much air', 'We already have a dryer on the mill side'],
  },
  'Haas:UMC-750': {
    description: '5-axis universal machining center. Premium Haas machine — shops running these are doing complex, high-value work. Higher air demand from trunnion + rotary.',
    typical_applications: ['5-axis contouring', 'aerospace components', 'complex geometries', 'mold work'],
    industries: ['aerospace', 'medical', 'defense', 'mold making'],
    air_usage_notes: 'Trunnion table rotation is pneumatically clamped. Through-spindle air blast common for deep pocket work. 5-axis programs run longer cycles = sustained demand.',
    common_air_problems: ['pressure fluctuations during simultaneous trunnion clamp and tool change', 'oil contamination affecting rotary axis seals'],
    recommended_air_quality: 'Dried and filtered air — rotary axis seals are expensive and moisture-sensitive',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'UMC-750 shops are investing in capability. They care about uptime, not just price. Sell on air quality and reliability.',
    key_selling_points: ['A rotary seal replacement is $3-5K in parts and downtime — clean dry air prevents it', 'These shops are making high-margin parts. Air quality directly affects surface finish on 5-axis work'],
    common_objections: ['We already have a big compressor', 'Getting quotes from Kaeser'],
  },

  'Mazak:QTN-200': {
    description: 'Quick Turn Nexus 200 — Mazak\'s bread-and-butter turning center. Extremely common in mid-to-large job shops and production environments.',
    typical_applications: ['production turning', 'shaft work', 'mid-volume runs'],
    industries: ['automotive', 'aerospace', 'oil and gas', 'hydraulics'],
    air_usage_notes: 'Hydraulic chuck with pneumatic assist. Chip conveyor and parts catcher both pneumatic. Steady-state demand higher than Haas lathes due to more pneumatic accessories.',
    common_air_problems: ['undersized compressor inherited from when the shop had fewer machines', 'oil carryover degrading pneumatic valve performance on parts catcher'],
    recommended_air_quality: 'Dried air required for pneumatic valve longevity',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Mazak shops tend to be Mazak-loyal. If they have one QTN, they probably have 3-4. Size accordingly.',
    key_selling_points: ['Mazak pneumatic accessories are expensive to replace — clean air extends their life significantly', 'Mazak shops rarely have just one machine. Ask what else is on the floor.'],
    common_objections: ['Mazak dealer handles our service', 'We lease our equipment and air system came with the building'],
  },
  'Mazak:VTC-300C': {
    description: 'Vertical traveling column mill. Large work envelope with heavy material removal capability. Popular in mold shops and structural work.',
    typical_applications: ['mold base machining', 'large plate work', 'structural components'],
    industries: ['mold making', 'die casting', 'heavy equipment', 'energy'],
    air_usage_notes: 'Traveling column design means longer air line runs. Chip management air demand is high due to large work area. Often paired with coolant-through-spindle.',
    common_air_problems: ['pressure loss from long pipe runs to machine in back of shop', 'insufficient volume during heavy roughing cycles with continuous chip blow-off'],
    recommended_air_quality: 'General industrial quality adequate — these are roughing machines',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'VTC shops often have the machine furthest from the compressor. Check pipe sizing and layout.',
    key_selling_points: ['Long pipe runs kill pressure — proper sizing at the compressor eliminates the problem at the machine', 'Mold shops run these machines hard. They need volume, not just pressure.'],
    common_objections: ['We added a second drop closer to the machine', 'Our pipe is big enough'],
  },
  'Mazak:VARIAXIS i-300': {
    description: '5-axis machining center with full simultaneous contouring. High-end aerospace and medical work. Premium air demands from trunnion table and pallet system.',
    typical_applications: ['5-axis aerospace', 'turbine blades', 'medical implants', 'complex mold cores'],
    industries: ['aerospace', 'medical', 'defense', 'energy'],
    air_usage_notes: 'Continuous air demand during 5-axis contouring. Pallet changer models add significant intermittent demand. Through-spindle air blast standard.',
    common_air_problems: ['air quality affecting surface finish on critical aerospace parts', 'oil contamination causing pallet locator pin sticking'],
    recommended_air_quality: 'ISO 8573 Class 2 or better — surface finish on 5-axis parts is directly affected by air quality',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    recommended_filters: ['Coalescing filter mandatory before machine'],
    system_notes: 'VARIAXIS shops are AS9100 or ISO 13485 certified. They document everything. Sell on traceability and air quality certification.',
    key_selling_points: ['Surface finish rejects on a $2,000 turbine blade cost more than a year of filter changes', 'AS9100 shops need to document air quality — our system makes that easy'],
    common_objections: ['Our current system meets spec', 'We already have point-of-use filters'],
  },

  'Doosan:DNM 4500': {
    description: 'Doosan\'s best-selling vertical mill. Price-performance leader — very common in shops that compete on cost. Solid machine, often undersized on air.',
    typical_applications: ['job shop', 'production milling', 'general machining'],
    industries: ['automotive', 'general manufacturing', 'job shop'],
    air_usage_notes: 'Standard air for tool change, vise clamps, chip blow-off. Similar demand profile to Haas VF-2 but Doosan shops tend to run more machines per dollar.',
    common_air_problems: ['bought 3-4 machines at once and the old compressor can\'t keep up', 'pressure drops during shift change when all machines start simultaneously'],
    recommended_air_quality: 'Dried air recommended for tool holder longevity',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Doosan is the value play. These shops bought machines to make money, not to impress. Price-sensitive but understand ROI.',
    key_selling_points: ['You saved smart on the machines — now make sure the air system doesn\'t bottleneck your throughput', 'When you added that third DNM, did you upsize the compressor? Most shops don\'t.'],
    common_objections: ['We just spent $500K on machines, can\'t spend more right now', 'Our compressor handles it fine'],
  },
  'Doosan:DVF 5000': {
    description: '5-axis vertical machining center with direct-drive rotary table. Doosan\'s entry into 5-axis — shops stepping up from 3-axis work.',
    typical_applications: ['5-axis milling', 'complex parts', 'aerospace subcontract'],
    industries: ['aerospace', 'medical', 'defense', 'automotive'],
    air_usage_notes: 'Direct-drive rotary table uses less air than pneumatic trunnion but still needs clean, dry air for seals. Through-spindle air blast is standard.',
    common_air_problems: ['existing air system was sized for 3-axis work — 5-axis adds sustained demand', 'rotary table seal degradation from oil contamination'],
    recommended_air_quality: 'Dried and filtered — direct-drive table seals are precision components',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'DVF 5000 is often a shop\'s first 5-axis. They\'re investing in capability — the air system needs to keep up.',
    key_selling_points: ['You just invested in 5-axis capability — don\'t let a $200 seal failure take it offline', 'Moving from 3-axis to 5-axis changes your air demand profile. Time to re-evaluate.'],
    common_objections: ['The Doosan dealer didn\'t mention needing to upgrade air', 'We just bought this machine, give us a year'],
  },
  'Doosan:Puma 2600': {
    description: 'Heavy-duty turning center. Popular in production shops doing medium-to-large diameter work. Sub-spindle and Y-axis models (2600SY) are common.',
    typical_applications: ['production turning', 'heavy shafts', 'bar work'],
    industries: ['automotive', 'oil and gas', 'hydraulics', 'aerospace'],
    air_usage_notes: 'Hydraulic chuck with pneumatic tailstock. SY models add sub-spindle and Y-axis milling — both increase air demand. Bar feeder adds 3-5 CFM.',
    common_air_problems: ['bar feeder and lathe fighting for air during index cycles', 'moisture causing tailstock quill sticking in humid environments'],
    recommended_air_quality: 'Dried air mandatory for tailstock quill and bar feeder reliability',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'If it\'s a Puma 2600SY with bar feeder, treat air demand like a mill + lathe combined.',
    key_selling_points: ['Bar feeder downtime from air issues costs you parts per hour. The math is simple.', 'SY model? That\'s a mill and a lathe in one. Your air system needs to know that.'],
    common_objections: ['The bar feeder has its own air regulator', 'We\'ve never had a tailstock issue'],
  },

  'Brother:Speedio S500X2': {
    description: 'High-speed tapping and drilling center. Fastest tool-to-tool in the industry — 0.9 sec chip-to-chip. Extreme intermittent air demand from rapid tool changes.',
    typical_applications: ['high-speed tapping', 'drilling', 'light milling', 'production'],
    industries: ['automotive', 'electronics', 'medical', 'production job shop'],
    air_usage_notes: 'Tool change speed drives extremely high intermittent air spikes. 22-tool ATC cycling rapidly. Air blast between operations. Small tank on machine drains fast.',
    common_air_problems: ['pressure drops during rapid tool change sequences — the machine outruns the compressor', 'small receiver tank can\'t buffer the demand spikes'],
    recommended_air_quality: 'General industrial quality — these are production machines, not finishing machines',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'Brother Speedios are ALL about cycle time. Any air-related slowdown is directly visible in parts per hour. Consider a 120-gallon receiver near the machine.',
    key_selling_points: ['You bought a Speedio for speed. If your compressor can\'t keep up with a 0.9-sec tool change, you\'re leaving parts on the table.', 'A receiver tank near the machine buffers those demand spikes — cheap insurance for your cycle time.'],
    common_objections: ['It\'s a small machine, doesn\'t need much air', 'We have a tank on the main line'],
  },
  'Brother:Speedio R650X2': {
    description: '5-axis compact machining center. Brother\'s answer to complex parts at production speed. Combines Speedio speed with 5-axis capability.',
    typical_applications: ['5-axis production', 'complex small parts', 'medical implants', 'automotive components'],
    industries: ['medical', 'automotive', 'electronics', 'aerospace subcontract'],
    air_usage_notes: 'Same rapid tool change demand as S500X2 plus rotary tilting table clamping. Sustained demand during 5-axis contouring is higher than standard Speedio.',
    common_air_problems: ['existing system sized for 3-axis Speedio can\'t handle added 5-axis air demand', 'tilting table clamp pressure drops during simultaneous tool change'],
    recommended_air_quality: 'Dried air recommended — tilting table seals benefit from moisture-free air',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'R650X2 shops often run multiple Speedios. Quote the full cell, not one machine.',
    key_selling_points: ['5-axis Speedio is production 5-axis — air interruptions show up immediately in your scrap rate', 'If you\'re running a cell of Speedios, one undersized compressor bottlenecks the whole cell'],
    common_objections: ['Our S500 runs fine on this compressor, the R650 should too', 'Brother didn\'t spec a bigger compressor for 5-axis'],
  },

  'DMG Mori:DMU 50': {
    description: 'Premium 5-axis universal milling machine. Industry standard for high-precision 5-axis work. Shops running these demand top-tier air quality.',
    typical_applications: ['5-axis precision milling', 'aerospace components', 'medical devices', 'mold cores'],
    industries: ['aerospace', 'medical', 'mold making', 'defense'],
    air_usage_notes: 'Swivel rotary table clamping, through-spindle air, ATC with large magazine. DMG Mori machines have strict air quality requirements in their installation manuals.',
    common_air_problems: ['DMG Mori service flagging air quality during PM visits', 'warranty claims denied due to documented air quality issues'],
    recommended_air_quality: 'ISO 8573 Class 2 minimum — DMG Mori installation manuals specify this',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    recommended_filters: ['Coalescing + particulate filtration to meet OEM spec'],
    system_notes: 'DMG Mori service techs check air quality. If it doesn\'t meet spec, they document it — and it can void warranty coverage.',
    key_selling_points: ['DMG Mori will flag your air quality on a service visit. Get ahead of it.', 'A warranty denial on a $300K machine because of a $5K air system is an expensive lesson'],
    common_objections: ['DMG Mori hasn\'t said anything about our air', 'We meet the spec already'],
  },
  'Fanuc:ROBODRILL a-D21MiB5': {
    description: 'Ultra-fast drilling and tapping center. 0.7-sec chip-to-chip — fastest in class. Dominant in high-volume production cells. Air demand profile similar to Brother Speedio.',
    typical_applications: ['high-speed drilling', 'tapping', 'production cells', 'automotive components'],
    industries: ['automotive', 'electronics', 'production manufacturing'],
    air_usage_notes: '21-tool ATC with industry-fastest tool change. BT30 spindle — smaller tools but extreme cycle speed. Often run in cells of 4-8 machines with robotic loading.',
    common_air_problems: ['cell of 4+ ROBODRILLs overwhelming a single compressor', 'pressure recovery time too slow between rapid tool changes in back-to-back cycles'],
    recommended_air_quality: 'General industrial quality — production environment, not finishing',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'ROBODRILL cells are the ultimate test of air system sizing. 4 machines × 0.7-sec tool changes = massive intermittent demand. Size for peak, not average.',
    key_selling_points: ['A cell of ROBODRILLs is only as fast as its air supply. One pressure drop = four machines waiting.', 'These cells make parts by the thousands. Calculate the cost of one lost minute across a shift.'],
    common_objections: ['Fanuc sized the compressor when they installed the cell', 'We added a machine and it\'s still fine'],
  },

  // ── Remaining top-20 CNC machines ──

  'Haas:VF-1': {
    description: 'Compact Haas vertical mill. Sweet spot for small shops — bigger than a Mini Mill, more affordable than a VF-2. Very common first "real" VMC purchase.',
    typical_applications: ['small parts', 'prototyping', 'short runs', 'job shop'],
    industries: ['job shop', 'aerospace', 'medical', 'education'],
    air_usage_notes: 'Standard tool change and air blast. Lower duty cycle than VF-2 but same pneumatic accessories. Often paired with a Kurt vise — pneumatic vise clamp adds demand.',
    common_air_problems: ['shops upgrading from manual mill have no compressed air infrastructure', 'running air blast continuously as a coolant substitute wastes CFM'],
    recommended_air_quality: 'Dried air recommended — same taper corrosion risk as any Haas',
    recommended_compressor: 'JRS-7.5E',
    recommended_dryer: 'JRD-40',
    system_notes: 'VF-1 is the gateway drug. If they bought one, a VF-2 or lathe is next. Size for two machines minimum.',
    key_selling_points: ['You bought the VF-1 because it fits your shop now. Size the air system for where your shop is going.', 'A JRS-7.5E handles the VF-1 and leaves headroom for the next machine.'],
    common_objections: ['It\'s just one small machine', 'I\'ll upgrade the compressor when I add another machine'],
  },
  'Haas:VF-3': {
    description: 'Mid-size Haas vertical mill. Larger Y-travel than VF-2 — popular for bigger parts and mold work. Often the second or third Haas in a growing shop.',
    typical_applications: ['mid-size parts', 'mold bases', 'fixtures', 'production'],
    industries: ['mold making', 'aerospace', 'automotive', 'general manufacturing'],
    air_usage_notes: 'Same pneumatic profile as VF-2 but larger work envelope means more chip blow-off air usage. Often run with 4th axis or pallet system.',
    common_air_problems: ['shops added VF-3 without reassessing compressor capacity', 'oil mist from flood coolant contaminating air lines near machine'],
    recommended_air_quality: 'Dried air mandatory — taper and bearing protection',
    recommended_compressor: 'JRS-10E',
    recommended_dryer: 'JRD-40',
    system_notes: 'VF-3 shops are growing shops. They probably just added this machine. Good time to audit the whole air system.',
    key_selling_points: ['Adding a VF-3 means you outgrew your VF-2 work envelope. Did your air system grow too?', 'Mold work on a VF-3 demands consistent pressure — pressure drops show up in surface finish.'],
    common_objections: ['Same compressor ran two VF-2s fine', 'We\'ll deal with it at the next machine'],
  },
  'Haas:VF-5': {
    description: 'Large-format Haas vertical mill. 50×26" travel — the biggest standard Haas VMC. Shops running these are doing serious production or large-part work.',
    typical_applications: ['large parts', 'aerospace panels', 'mold work', 'fixtures'],
    industries: ['aerospace', 'mold making', 'heavy equipment', 'energy'],
    air_usage_notes: 'Large work envelope = more blow-off air. Dual vise setups common — double the pneumatic clamping demand. Long cycle times mean sustained air demand.',
    common_air_problems: ['pressure sag during long roughing cycles with continuous chip management', 'dual vise clamp cycling during pallet flip operations'],
    recommended_air_quality: 'Dried air mandatory — large investment machine deserves proper air',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'A VF-5 is a serious machine. These shops aren\'t price shopping — they need capacity and reliability.',
    key_selling_points: ['A VF-5 costs $80K+. A $3K air quality upgrade protects that investment.', 'Large-format milling means long cycles. Sustained air demand, not intermittent.'],
    common_objections: ['We have a big compressor already', 'Air hasn\'t been an issue'],
  },
  'Haas:VF-6': {
    description: 'Extra-large Haas vertical mill. 64×32" travel — aerospace longeron and panel work. Often the biggest machine on the floor and the furthest from the compressor.',
    typical_applications: ['aerospace structural', 'large mold bases', 'energy components', 'heavy machining'],
    industries: ['aerospace', 'energy', 'heavy equipment', 'defense'],
    air_usage_notes: 'Massive work envelope drives high chip management air demand. Through-spindle air blast standard at this size. Machine weight means it\'s installed far from the compressor — long pipe runs.',
    common_air_problems: ['pressure drop from long pipe runs to machine at back of shop', 'insufficient receiver capacity for sustained roughing cycles'],
    recommended_air_quality: 'Dried air mandatory — these parts are high-value',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'VF-6 is Haas\'s biggest standard VMC. If a shop has one, they\'re doing big work with big margins. Sell on reliability, not price.',
    key_selling_points: ['The VF-6 is usually the farthest machine from the compressor. Pipe sizing matters more than compressor size at that point.', 'Aerospace structural work on a VF-6 means every part is traceable. Air quality is part of that traceability.'],
    common_objections: ['We added a drop closer to the machine', 'Our foreman says air is fine'],
  },
  'Haas:EC-400': {
    description: 'Horizontal machining center with dual pallet changer. Pallet changes are big air events — pneumatic clamping on both pallets plus chip evacuation between changes.',
    typical_applications: ['production milling', 'tombstone work', 'multi-face machining', 'high-volume'],
    industries: ['automotive', 'aerospace', 'medical', 'production job shop'],
    air_usage_notes: 'Pallet change cycle uses pneumatic clamping on both pallets simultaneously. Tombstone fixtures add 4-6 pneumatic clamps per pallet. Chip evacuation between pallet swaps is air-intensive.',
    common_air_problems: ['pallet clamp pressure drops during rapid changeover — causes pallet position error alarm', 'tombstone fixtures with 8+ pneumatic clamps overwhelm single drop line'],
    recommended_air_quality: 'Dried and filtered — pallet locating pins and clamps are precision components',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    recommended_filters: ['Coalescing filter recommended — pallet mechanism sensitivity'],
    system_notes: 'EC-400 is Haas\'s production workhorse. These shops run lights-out or close to it. Air reliability is non-negotiable.',
    key_selling_points: ['A pallet error alarm at 2 AM during lights-out means lost production until morning. Clean, consistent air prevents it.', 'Tombstone fixtures multiply your air demand by the number of clamps. 4 fixtures × 4 clamps = 16 pneumatic consumers.'],
    common_objections: ['We only run one shift', 'The pallet changer doesn\'t use that much air'],
  },
  'Mazak:QTN-300': {
    description: 'Large-bore Quick Turn Nexus. Handles bigger bar stock and chucking work than the QTN-200. Common in oil and gas, hydraulics, and heavy equipment shops.',
    typical_applications: ['large-diameter turning', 'oil field components', 'hydraulic cylinders', 'heavy shafts'],
    industries: ['oil and gas', 'hydraulics', 'heavy equipment', 'aerospace'],
    air_usage_notes: 'Larger chuck = more pneumatic clamping force = more air per cycle. Heavy parts mean stronger tailstock engagement — higher air demand during load/unload. Bar feeder for large stock adds significant demand.',
    common_air_problems: ['large-bar feeder cycling causing pressure dips across the shop', 'chuck clamping force inconsistency from pressure fluctuations during multi-machine operation'],
    recommended_air_quality: 'Dried air mandatory — heavy hydraulic/pneumatic systems need clean air for valve longevity',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'QTN-300 shops are doing heavy work. They care about uptime and clamping reliability. Sell on consistency under load.',
    key_selling_points: ['Large-bore chucking means large pneumatic forces. Pressure fluctuations show up as clamping inconsistency.', 'Oil and gas work tolerates zero part ejection failures. That starts with consistent air.'],
    common_objections: ['We sized the compressor when we bought the QTN-200', 'Our air system handles the whole shop fine'],
  },
  'Doosan:DNM 5700': {
    description: 'Large-format Doosan vertical mill. 57×30" travel — Doosan\'s answer to the Haas VF-5/VF-6. Same value-play positioning with bigger capability.',
    typical_applications: ['large parts', 'mold bases', 'structural components', 'production'],
    industries: ['mold making', 'aerospace', 'heavy equipment', 'energy'],
    air_usage_notes: 'Large work envelope and heavy material removal = high chip management air demand. Often run with coolant-through-spindle, reducing air blast usage but still needing clean dry supply air.',
    common_air_problems: ['same pressure-drop-from-long-pipe-runs issue as any large VMC at the back of the shop', 'insufficient receiver capacity for sustained roughing with continuous chip blow-off'],
    recommended_air_quality: 'Dried air recommended — mold work demands consistent finish quality',
    recommended_compressor: 'JRS-15E',
    recommended_dryer: 'JRD-80',
    system_notes: 'DNM 5700 is Doosan\'s big-envelope play. Shops bought it for value — they\'ll respond to ROI arguments on air.',
    key_selling_points: ['You saved on the machine versus a Mazak or DMG Mori. Now invest that savings where it protects your throughput.', 'Mold base work on a DNM 5700 means long cycles. One pressure drop mid-cycle = one scrapped mold base.'],
    common_objections: ['We already have a big compressor from the last machine', 'Doosan dealer said our air was fine'],
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
         -- xmax = 0: Postgres MVCC detail — freshly inserted rows have xmax 0,
         -- conflict-updated rows have a non-zero xmax from the prior version.
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

    // Verification — use same client to guarantee read-your-writes
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*)::int AS count FROM equipment_catalog');
    console.log(`equipment_catalog total rows: ${count}`);

    const { rows: categories } = await client.query(
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

// Allow test imports without running the seed
if (require.main === module) {
  seed();
}

module.exports = { DETAILS };
