function item(key, es, en, kind = "bool", extra = {}) {
  return { key, label: { es, en }, kind, ...extra };
}

function action(id, es, en, command) {
  return { id, label: { es, en }, kind: "action", command };
}

const hitboxOptions = {
  es: ["Cabeza", "Cuello", "Pecho", "Pelvis"],
  en: ["Head", "Neck", "Chest", "Pelvis"]
};

const radarCornerOptions = {
  es: ["Arriba izq.", "Arriba der.", "Abajo izq.", "Abajo der."],
  en: ["Top left", "Top right", "Bottom left", "Bottom right"]
};

const strafePatterns = { es: ["WASD", "SDAW", "SAWD", "DWAS"], en: ["WASD", "SDAW", "SAWD", "DWAS"] };
const strafeModes = {
  es: ["Toggle (iniciar / detener)", "Hold (mantener tecla)"],
  en: ["Toggle (start / stop)", "Hold (keep key pressed)"]
};

const espPosOptions = {
  es: ["Abajo", "Arriba", "Izq. superior", "Der. superior", "Izq. inferior", "Der. inferior"],
  en: ["Bottom", "Top", "Left Upper", "Right Upper", "Left Lower", "Right Lower"]
};

const weaponPresets = {
  es: ["WEAPON_PISTOL", "WEAPON_COMBATPISTOL", "WEAPON_SMG", "WEAPON_ASSAULTRIFLE", "WEAPON_CARBINERIFLE", "WEAPON_PUMPSHOTGUN", "WEAPON_SNIPERRIFLE", "WEAPON_STUNGUN", "WEAPON_KNIFE", "WEAPON_GRENADE"],
  en: ["WEAPON_PISTOL", "WEAPON_COMBATPISTOL", "WEAPON_SMG", "WEAPON_ASSAULTRIFLE", "WEAPON_CARBINERIFLE", "WEAPON_PUMPSHOTGUN", "WEAPON_SNIPERRIFLE", "WEAPON_STUNGUN", "WEAPON_KNIFE", "WEAPON_GRENADE"]
};

const { extraSections, extraCategoryPatches } = require("./panel-schema-extra");

module.exports = {
  version: 5,
  categories: [
    { id: "combat", es: "Combate", en: "Combat", sections: [0, 1, 2, 3] },
    { id: "visuals", es: "Visuales", en: "Visuals", sections: [4, ...extraCategoryPatches.visuals] },
    { id: "exploits", es: "Exploits", en: "Exploits", sections: [5, 6, 7] },
    { id: "misc", es: "Miscelaneo", en: "Misc", sections: [8, 9, 10, 11, 12, 13, ...extraCategoryPatches.misc] }
  ],
  sections: [
    {
      id: 0,
      es: "Aimbot",
      en: "Aimbot",
      groups: [
        {
          es: "Enable",
          en: "Enable",
          items: [
            item("abt_enabled", "Activar Aimbot", "Enable Aimbot"),
            item("misc_localplayer_showaimbotfov", "Mostrar FOV del Aimbot", "Show Aimbot FOV", "int", { min: 0, max: 1 }),
            item("misc_localplayer_showaimbotline", "Linea del Objetivo Fijado", "Locked Target Line", "int", { min: 0, max: 1 }),
            item("abt_targetnpc", "Apuntar a NPCs", "Target NPCs")
          ]
        },
        {
          es: "Configurar",
          en: "Configure",
          items: [
            item("VisibleCheck", "Verificar Visibilidad", "Visible Check"),
            item("abt_hitbox", "Objetivo (Hueso)", "Aim Bone", "int", { min: 0, max: 3, options: hitboxOptions }),
            item("abt_maxdistance", "Distancia Maxima", "Max Distance", "int", { min: 0, max: 1000 }),
            item("abt_fov", "Campo de Vision (FOV)", "Aimbot FOV", "int", { min: 0, max: 360 }),
            item("abt_smooth", "Suavizado", "Smooth", "int", { min: 1, max: 100 })
          ]
        }
      ]
    },
    {
      id: 1,
      es: "Silent",
      en: "Silent",
      groups: [
        {
          es: "Enable",
          en: "Enable",
          items: [
            item("slt_enabled", "Aimbot Invisible (Silent)", "Silent Aimbot"),
            item("misc_localplayer_showsilentfov", "Mostrar FOV del Silent", "Show Silent FOV", "int", { min: 0, max: 1 })
          ]
        },
        {
          es: "Configurar",
          en: "Configure",
          items: [
            item("slt_fov", "FOV del Silent", "Silent FOV", "int", { min: 0, max: 360 }),
            item("slt_maxdistance", "Distancia Maxima", "Max Distance", "int", { min: 0, max: 500 }),
            item("slt_hitbox", "Objetivo (Hitbox)", "Silent Hitbox", "int", { min: 0, max: 3, options: hitboxOptions }),
            item("VisibleCheck_silent", "Verificar Visibilidad", "Visible Check"),
            item("slt_shotnpc", "Apuntar a NPCs", "Target NPCs"),
            item("slt_shotdead", "Disparar a Muertos", "Target Dead Players"),
            item("slt_prediction", "Prediccion", "Movement Prediction"),
            item("slt_forcedriver", "Forzar Conductor", "Force Target Driver"),
            item("slt_autoshoot", "Disparo Automatico", "Auto Shoot"),
            item("slt_autodistance", "Ajuste de Distancia Auto", "Auto Distance Adjust"),
            item("slt_aliveonly", "Solo Vivos", "Alive Players Only"),
            item("slt_randombone", "Hueso Aleatorio", "Random Target Bone"),
            item("slt_closestbone", "Hueso Mas Cercano", "Closest Target Bone"),
            item("slt_misschance", "Probabilidad de Error", "Human Error Chance", "int", { min: 0, max: 100 }),
            item("slt_ragefov", "Rage FOV", "Rage FOV", "int", { min: 0, max: 360 }),
            item("slt_autoshootdelay", "Retraso de Disparo Auto", "Auto Shoot Delay", "int", { min: 0, max: 500 })
          ]
        }
      ]
    },
    {
      id: 2,
      es: "Bala Magica",
      en: "Magic",
      groups: [
        {
          es: "Enable",
          en: "Enable",
          items: [
            item("magic_enabled", "Bala Magica (Atraviesa)", "Magic Bullet (Shoot Through)"),
            item("misc_localplayer_showmagicfov", "Mostrar FOV de Magic Bullet", "Show Magic Bullet FOV", "int", { min: 0, max: 1 })
          ]
        },
        {
          es: "Configurar",
          en: "Configure",
          items: [
            item("magic_fov", "FOV de Magic Bullet", "Magic Bullet FOV", "int", { min: 0, max: 360 }),
            item("magic_maxdist", "Distancia maxima (Magic Bullet)", "Magic Bullet max distance", "int", { min: 0, max: 500 }),
            item("magic_hitbox", "Hitbox (Magic Bullet)", "Magic Bullet hitbox", "int", { min: 0, max: 3, options: hitboxOptions }),
            item("magic_visible", "Verificar visibilidad (Magic Bullet)", "Magic Bullet visible check"),
            item("magic_shotnpc", "Apuntar a NPCs (Magic Bullet)", "Magic Bullet target NPC")
          ]
        }
      ]
    },
    {
      id: 3,
      es: "TriggerBot",
      en: "TriggerBot",
      groups: [
        {
          es: "Enable",
          en: "Enable",
          items: [
            item("trg_enabled", "Activar Triggerbot", "Enable Triggerbot"),
            item("trg_shotnpc", "Disparar a NPCs", "Shoot NPCs"),
            item("trg_visible", "Verificar Visibilidad", "Visible Check"),
            item("trg_shoot_walls", "Disparar detras de paredes", "Shoot through walls"),
            item("misc_localplayer_showtriggerfov", "Mostrar FOV del Trigger", "Show Trigger FOV")
          ]
        },
        {
          es: "Configurar",
          en: "Configure",
          items: [
            item("trg_fov", "FOV del Trigger", "Trigger FOV", "int", { min: 1, max: 360 }),
            item("trg_maxdistance", "Distancia Maxima", "Max Catch Distance", "int", { min: 0, max: 1000 }),
            item("trg_reaction", "Tiempo de Reaccion", "Reaction Delay", "int", { min: 0, max: 500 })
          ]
        }
      ]
    },
    {
      id: 4,
      es: "Visuales",
      en: "Visuals",
      groups: [
        {
          es: "Players",
          en: "Players",
          items: [
            item("esp_players_enabled", "Activar ESP General", "Enable Main ESP"),
            item("esp_players_key", "Tecla toggle ESP (VK)", "ESP toggle key (VK)", "int", { min: 0, max: 255 }),
            item("esp_players_localplayer", "Mostrar Local", "Show Local"),
            item("esp_players_npscs", "Mostrar NPCs", "Show NPCs"),
            item("esp_players_showdead", "Mostrar Muertos", "Show Dead Bodies"),
            item("esp_players_visibleonly", "Solo Visibles", "Visible Only"),
            item("esp_players_box", "Caja ESP (Box)", "2D Bounding Box"),
            item("esp_players_filledbox", "Relleno de Caja", "Box Area Fill"),
            item("esp_players_cornerbox", "Esquinas de Caja", "Corner Styles"),
            item("esp_players_skel", "Esqueleto", "Full Skeleton"),
            item("esp_players_head", "Circulo en la Cabeza", "Head Circle"),
            item("esp_players_name", "Nombre del Jugador", "Player Identifier"),
            item("esp_players_pnames", "Nombres jugador", "Player Names"),
            item("esp_players_healthbar", "Barra de Vida", "Health Meter", "int", { min: 0, max: 1 }),
            item("esp_players_armorbar", "Barra de Colete", "Armor Meter", "int", { min: 0, max: 1 }),
            item("esp_players_weapname", "Arma en Mano", "Current Weapon", "int", { min: 0, max: 1 }),
            item("esp_players_distance", "Distancia", "Distance Marker"),
            item("esp_players_snampli", "Linhas (Snaplines)", "Screen Snaplines"),
            item("esp_players_modern", "Estilo Moderno", "Modern Interface Style"),
            item("esp_players_gradfill", "Gradiente en el Relleno", "Gradient Fill"),
            item("esp_players_glow", "Efecto de Brillo (Glow)", "Glow Effect"),
            item("esp_players_rainbow", "Cores RGB (Rainbow)", "Rainbow ESP"),
            item("esp_players_renderdist", "Distancia de Renderizado", "Render Distance", "int", { min: 0, max: 1000 }),
            item("esp_players_highlightvisible", "Resaltar al Ser Visible", "Highlight Visible"),
            item("esp_players_head_radius", "Tamano de la Cabeza", "Head Size", "float", { min: 1, max: 30, step: 0.5 }),
            item("esp_radar_enabled", "Radar 2D", "2D Radar"),
            item("esp_radar_corner", "Posicion radar", "Radar position", "int", { min: 0, max: 3, options: radarCornerOptions }),
            item("esp_radar_size", "Tamanio radar", "Radar size", "float", { min: 80, max: 280, step: 1 }),
            item("esp_radar_range", "Rango radar (m)", "Radar range (m)", "float", { min: 25, max: 500, step: 1 }),
            item("esp_radar_offx", "Offset X", "Offset X", "float", { min: 0, max: 400, step: 1 }),
            item("esp_radar_offy", "Offset Y", "Offset Y", "float", { min: 0, max: 400, step: 1 }),
            item("esp_radar_rotate", "Rotar con camara", "Rotate with camera"),
            item("esp_radar_circle", "Estilo circular", "Circle style"),
            item("esp_radar_npcs", "Mostrar NPCs radar", "Show NPCs on radar"),
            item("esp_radar_names", "Mostrar nombres radar", "Show names on radar")
          ]
        },
        {
          es: "Vehicles",
          en: "Vehicles",
          items: [
            item("esp_vehicles_enabled", "Activar ESP Vehiculos", "Enable Vehicle ESP"),
            item("esp_vehicles_ignoreoccupied", "Ignorar Autos Ocupados", "Ignore Occupied Vehicles"),
            item("esp_vehicles_marker", "Marcador 3D", "3D Marker"),
            item("esp_vehicles_distance", "Mostrar Distancia", "Show Distance"),
            item("esp_vehicles_name", "Mostrar Placa/Nombre", "Show Name/Plate")
          ]
        },
        {
          es: "Settings",
          en: "Settings",
          items: [
            item("esp_players_box_thick", "Grosor de la Caja", "Box Thickness", "float", { min: 0.5, max: 5, step: 0.1 }),
            item("esp_players_outline_thick", "Grosor del Borde", "Outline Thickness", "float", { min: 0.5, max: 5, step: 0.1 }),
            item("esp_players_corner_len", "Longitud de Esquinas", "Corner Length", "float", { min: 1, max: 40, step: 1 }),
            item("esp_players_glowalpha", "Opacidad del Brillo", "Glow Alpha", "float", { min: 0, max: 1, step: 0.01 }),
            item("esp_players_box_round", "Redondeo caja", "Box rounding", "float", { min: 0, max: 12, step: 0.5 }),
            item("esp_players_corner_thick", "Grosor esquinas", "Corner thickness", "float", { min: 0.5, max: 5, step: 0.1 }),
            item("esp_players_snapline_thick", "Grosor snapline", "Snapline thickness", "float", { min: 0.5, max: 5, step: 0.1 }),
            item("esp_players_headcircle_thick", "Grosor circulo cabeza", "Head circle thickness", "float", { min: 0.5, max: 5, step: 0.1 }),
            item("esp_players_pos_offx", "Offset X ESP", "ESP offset X", "float", { min: -50, max: 50, step: 1 }),
            item("esp_players_pos_offy", "Offset Y ESP", "ESP offset Y", "float", { min: -50, max: 50, step: 1 }),
            item("esp_players_name_pos", "Posicion nombre", "Name position", "int", { min: 0, max: 5, options: espPosOptions }),
            item("esp_players_weapon_pos", "Posicion arma", "Weapon position", "int", { min: 0, max: 5, options: espPosOptions }),
            item("esp_players_distance_pos", "Posicion distancia", "Distance position", "int", { min: 0, max: 5, options: espPosOptions }),
            item("esp_players_health_pos", "Posicion barra vida", "Health bar position", "int", { min: 0, max: 5, options: espPosOptions })
          ]
        },
        {
          es: "Admin ESP",
          en: "Admin ESP",
          items: [
            item("esp_admin_enabled", "Activar ESP Admin", "Enable Admin ESP"),
            item("esp_admin_skeleton", "Mostrar Esqueleto RGB", "Show RGB Skeleton"),
            item("esp_admin_lines", "Mostrar Lineas RGB", "Show RGB Lines"),
            item("esp_admin_panel", "Mostrar Lista de Admins", "Show Admin List"),
            item("esp_admin_rainbow", "Efecto RGB (Rainbow)", "Rainbow Effect")
          ]
        }
      ]
    },
    {
      id: 5,
      es: "Jugador",
      en: "Self",
      groups: [
        {
          es: "Movement",
          en: "Movement",
          items: [
            item("Noclip", "Noclip", "Noclip"),
            item("exp_invisible_noclip", "Invisible en Noclip", "Invisible while noclip"),
            item("NoclipSpeed", "Velocidad del Noclip", "Noclip Speed", "int", { min: 1, max: 500 }),
            item("exp_speed_hack", "Velocidad del Jugador (Speed)", "Player Speed"),
            item("exp_speed_value", "Multiplicador de Velocidad", "Speed Multiplier", "float", { min: 0.5, max: 5, step: 0.05 }),
            item("exp_custom_fov", "FOV", "Custom FOV"),
            item("exp_fov_value", "Angulo del FOV", "FOV Angle", "float", { min: 50, max: 120, step: 1 })
          ]
        },
        {
          es: "Player",
          en: "Player",
          items: [
            item("exp_anti_hs", "Proteccion contra Headshot", "Anti Headshot"),
            item("God", "Godmode completo (inestable)", "Full Godmode"),
            item("exp_infinite_stamina", "Stamina Infinita", "Infinite Stamina"),
            item("exp_shrink", "Jugador Pequeño (Tiny)", "Tiny Player"),
            item("exp_player_scale", "Tamaño del personaje (solo local)", "Player size (local only)", "float", { min: 0.1, max: 5, step: 0.05 }),
            item("exp_super_jump", "Super Salto", "Super Jump"),
            item("exp_no_collision", "Atravesar Paredes", "No Collision"),
            item("exp_no_ragdoll", "No radgoll", "No Ragdoll"),
            item("exp_invisible", "Invisible", "Invisible"),
            item("exp_bullet_bypass", "Enable Bullets Bypass", "Bullets Bypass"),
            item("exp_antiaim_local", "Girar Boneco (Anti Aim)", "Anti Aim"),
            item("exp_health_amount", "Cantidad de Vida", "Health Amount", "int", { min: 1, max: 400 }),
            action("apply_health", "Aplicar Vida", "Apply Health", { type: "pulse", name: "exp_apply_health" }),
            action("teleport_waypoint", "Teleportar para Waypoint", "Teleport to Waypoint", { type: "pulse", name: "exp_teleport_waypoint" })
          ]
        },
        {
          es: "Spawn de armas",
          en: "Weapon Spawn",
          items: [
            item("wpnspawn_bypass", "Bypass anti-armas", "Weapon bypass"),
            item("wpnspawn_preset", "Arma", "Weapon preset", "int", { min: 0, max: 9, options: weaponPresets }),
            item("wpnspawn_ammo", "Municion", "Ammo", "int", { min: 1, max: 9999 }),
            action("spawn_weapon", "Spawnear arma", "Spawn weapon", { type: "spawn_weapon" })
          ]
        }
      ]
    },
    {
      id: 6,
      es: "Armas",
      en: "Weapon",
      groups: [
        {
          es: "Weapon",
          en: "Weapon",
          items: [
            item("wpn_size_enabled", "Activar Tamaño Del Arma", "Weapon Size Enabled"),
            item("wpn_size", "Ajustar Tamaño Del Arma", "Weapon Size", "float", { min: 0.1, max: 3, step: 0.05 }),
            item("wpn_infiniteammo", "Municion Infinita", "Infinite Ammo"),
            item("wpn_nospread", "Control Balas Dispersadas", "No Spread"),
            item("wpn_spread_value", "Ajustar Dispersacion", "Spread Value", "float", { min: 0, max: 10, step: 0.1 }),
            item("wpn_norecoil", "Control Recoil", "No Recoil"),
            item("wpn_recoil_value", "Ajustar Recoil", "Recoil Value", "float", { min: 0, max: 10, step: 0.1 }),
            item("wpn_noreload", "Recarga Instantanea", "Fast Reload"),
            item("wpn_range_mod", "Modificar Alcance", "Range Modify"),
            item("wpn_range_value", "Valor de Alcance", "Range Value", "float", { min: 0, max: 500, step: 1 }),
            item("wpn_damage_boost", "Aumento de Daño", "Damage Boost"),
            item("wpn_damage_value", "Valor de Daño", "Damage Value", "float", { min: 0, max: 500, step: 1 }),
            item("wpn_safe_damage_boost", "Daño Seguro", "Safe Damage Boost"),
            item("wpn_safe_damage_value", "Valor de Daño Seguro", "Safe Damage Value", "float", { min: 0, max: 500, step: 1 })
          ]
        }
      ]
    },
    {
      id: 7,
      es: "Vehiculos",
      en: "Vehicle",
      groups: [
        {
          es: "Vehicle",
          en: "Vehicle",
          items: [
            item("veh_tune_enable", "Activar Tuneo", "Enable Vehicle Tuning"),
            item("veh_boost", "Velocidad del coche", "Vehicle Boost", "float", { min: 0, max: 50, step: 0.1 }),
            item("veh_traction", "Grip al suelo (Handling)", "Traction", "float", { min: 0, max: 10, step: 0.1 }),
            item("veh_color_enabled", "Cambiar Color del Vehiculo", "Vehicle Color"),
            item("veh_primary_enabled", "Color primario activo", "Primary color enabled"),
            item("veh_primary_r", "Color primario R", "Primary R", "int", { min: 0, max: 255 }),
            item("veh_primary_g", "Color primario G", "Primary G", "int", { min: 0, max: 255 }),
            item("veh_primary_b", "Color primario B", "Primary B", "int", { min: 0, max: 255 }),
            item("veh_secondary_enabled", "Color secundario", "Secondary color enabled"),
            item("veh_secondary_r", "Secundario R", "Secondary R", "int", { min: 0, max: 255 }),
            item("veh_secondary_g", "Secundario G", "Secondary G", "int", { min: 0, max: 255 }),
            item("veh_secondary_b", "Secundario B", "Secondary B", "int", { min: 0, max: 255 }),
            item("veh_carry", "Lanzar Coche", "Carry Vehicle"),
            action("repair_vehicle", "Reparar Vehiculo", "Repair Vehicle", { type: "pulse", name: "veh_repair_once" }),
            action("unlock_vehicle", "Desbloquear Auto Cercano", "Unlock Nearest Vehicle", { type: "pulse", name: "exp_unlock_key" }),
            item("veh_fix", "Reparar Estado", "Repair State"),
            item("veh_godmode", "Godmode del Vehiculo", "Vehicle Godmode"),
            item("veh_engine_fix", "Reparar Motor", "Engine Fix"),
            item("veh_petrol_fix", "Reparar deposito gasolina", "Petrol tank fix"),
            item("veh_oil_fix", "Reparar deposito aceite", "Oil tank fix"),
            item("veh_water_fix", "Reparar deposito agua", "Water tank fix"),
            item("veh_never_explode", "Nunca Explodir", "Never Explode")
          ]
        }
      ]
    },
    {
      id: 8,
      es: "TxAdmin",
      en: "TxAdmin",
      dynamic: "txadmin"
    },
    {
      id: 9,
      es: "Resources",
      en: "Resources",
      dynamic: "resources"
    },
    {
      id: 10,
      es: "Lista",
      en: "List",
      dynamic: "list"
    },
    {
      id: 11,
      es: "Lua",
      en: "Lua",
      dynamic: "lua"
    },
    {
      id: 12,
      es: "Macros",
      en: "Macros",
      groups: [
        {
          es: "Macros",
          en: "Macros",
          items: [
            item("macro_strafe_enabled", "Macro strafe", "Strafe macro"),
            item("macro_strafe_pattern", "Patron (WASD/SDAW/SAWD/DWAS)", "Pattern", "int", { min: 0, max: 3, options: strafePatterns }),
            item("macro_strafe_mode", "Modo", "Mode", "int", { min: 0, max: 1, options: strafeModes }),
            item("macro_strafe_hold_ms", "Tiempo pulsado (ms)", "Key hold (ms)", "int", { min: 5, max: 300 }),
            item("macro_strafe_gap_ms", "Pausa entre teclas (ms)", "Gap between keys (ms)", "int", { min: 0, max: 300 })
          ]
        }
      ]
    },
    {
      id: 13,
      es: "Ajustes",
      en: "Settings",
      groups: [
        {
          es: "Acciones",
          en: "Actions",
          items: [
            action("panel_unload", "Unload Cheat", "Unload Cheat", { type: "unload" }),
            action("panel_bypass", "Bypass", "Bypass", { type: "bypass" })
          ]
        },
        {
          es: "Menu / HUD",
          en: "Menu / HUD",
          items: [
            item("menu_background_snow", "Fondo constelacion", "Constellation background"),
            item("hud_brand_watermark", "Marca de agua (logo + tiempo)", "Brand watermark (logo + time)"),
            item("hud_crosshair", "Mira (crosshair)", "Crosshair"),
            item("ui_visual_quality", "Calidad visual", "Visual quality", "int", {
              min: 0,
              max: 2,
              options: {
                es: ["Rendimiento", "Equilibrado", "Nitido"],
                en: ["Performance", "Balanced", "Crisp"]
              }
            })
          ]
        },
        {
          es: "Security",
          en: "Security",
          items: [
            item("safe_mode", "Modo Seguro (bloquea exploits)", "Safe Mode"),
            item("captbypss", "Stream Proof", "Stream Proof"),
            item("gpu_capt_bypass", "Stream Proof Nvidia/AMD", "GPU Stream Proof"),
            item("second_monitor", "Modo Segundo Monitor", "Second Monitor"),
            item("hide_menu_unfocused", "Ocultar menu al cambiar de ventana", "Hide menu when unfocused"),
            item("mobile_control_only", "Solo control movil (ocultar menu PC)", "Mobile-only control (hide PC menu)"),
            item("thd_delay", "Retraso del Procesamiento", "Thread Delay", "int", { min: 0, max: 100 }),
            item("login_orange_particles", "Particulas login", "Login particles")
          ]
        }
      ]
    },
    ...extraSections
  ]
};
