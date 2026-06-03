function item(key, es, en, kind = "bool", extra = {}) {
  return { key, label: { es, en }, kind, ...extra };
}

function rgba4(prefix, esName, enName) {
  return [
    item(`${prefix}0`, `${esName} R`, `${enName} R`, "float", { min: 0, max: 1, step: 0.01 }),
    item(`${prefix}1`, `${esName} G`, `${enName} G`, "float", { min: 0, max: 1, step: 0.01 }),
    item(`${prefix}2`, `${esName} B`, `${enName} B`, "float", { min: 0, max: 1, step: 0.01 }),
    item(`${prefix}3`, `${esName} A`, `${enName} A`, "float", { min: 0, max: 1, step: 0.01 })
  ];
}

const extraSections = [
  {
    id: 14,
    es: "Colores ESP",
    en: "ESP Colors",
    groups: [
      {
        es: "Jugador",
        en: "Player",
        items: [
          ...rgba4("esp_players_boxco", "Caja", "Box"),
          ...rgba4("esp_players_cornerboxco", "Esquinas", "Corner box"),
          ...rgba4("esp_players_filledboxco", "Relleno caja", "Filled box"),
          ...rgba4("esp_players_skelco", "Esqueleto", "Skeleton"),
          ...rgba4("esp_players_skelvis", "Esqueleto visible", "Skeleton visible"),
          ...rgba4("esp_players_skelocc", "Esqueleto oculto", "Skeleton occluded"),
          ...rgba4("esp_players_NAMEco", "Nombre", "Name"),
          ...rgba4("esp_players_weaponNAMEco", "Arma", "Weapon name"),
          ...rgba4("esp_players_distanceco", "Distancia", "Distance"),
          ...rgba4("esp_players_snaplinesco", "Snaplines", "Snaplines"),
          ...rgba4("esp_players_headco", "Cabeza", "Head")
        ]
      },
      {
        es: "Gradiente y vehiculos",
        en: "Gradient and vehicles",
        items: [
          ...rgba4("esp_players_gradtop", "Gradiente arriba", "Gradient top"),
          ...rgba4("esp_players_gradbot", "Gradiente abajo", "Gradient bottom"),
          item("esp_players_glowpasses", "Pasadas glow", "Glow passes", "int", { min: 1, max: 8 }),
          item("esp_players_glowspread", "Spread glow", "Glow spread", "float", { min: 1, max: 10, step: 0.1 }),
          ...rgba4("esp_vehicles_col", "Color vehiculo", "Vehicle color"),
          ...rgba4("esp_FriendsColor", "Color amigos", "Friend color")
        ]
      }
    ]
  },
  {
    id: 15,
    es: "Colores FOV / Radar",
    en: "FOV / Radar Colors",
    groups: [
      {
        es: "FOV y lineas",
        en: "FOV and lines",
        items: [
          ...rgba4("misc_aimbotfovcol", "FOV Aimbot", "Aimbot FOV"),
          ...rgba4("misc_silentfovcol", "FOV Silent", "Silent FOV"),
          ...rgba4("misc_magicfovcol", "FOV Magic", "Magic FOV"),
          ...rgba4("misc_triggerfovcol", "FOV Trigger", "Trigger FOV"),
          ...rgba4("misc_aimbotlinecol", "Linea objetivo", "Target line"),
          ...rgba4("hud_crosshair", "Crosshair", "Crosshair")
        ]
      },
      {
        es: "Radar",
        en: "Radar",
        items: [
          ...rgba4("esp_radar_bg", "Fondo radar", "Radar background"),
          ...rgba4("esp_radar_bd", "Borde radar", "Radar border"),
          ...rgba4("esp_radar_en", "Enemigo radar", "Radar enemy"),
          ...rgba4("esp_radar_fr", "Amigo radar", "Radar friend"),
          item("esp_radar_dot", "Radio punto radar", "Radar dot radius", "float", { min: 1, max: 8, step: 0.5 }),
          item("esp_radar_local", "Mostrar local radar", "Show local on radar"),
          item("esp_radar_ring", "Anillo distancia radar", "Radar distance ring")
        ]
      }
    ]
  },
  {
    id: 16,
    es: "Teclas y binds",
    en: "Keys and binds",
    groups: [
      {
        es: "Combate",
        en: "Combat",
        items: [
          item("abt_key", "Tecla Aimbot (VK)", "Aimbot key (VK)", "int", { min: 0, max: 255 }),
          item("slt_key", "Tecla Silent (VK)", "Silent key (VK)", "int", { min: 0, max: 255 }),
          item("magic_key", "Tecla Magic (VK)", "Magic key (VK)", "int", { min: 0, max: 255 }),
          item("trg_key", "Tecla Trigger (VK)", "Trigger key (VK)", "int", { min: 0, max: 255 })
        ]
      },
      {
        es: "Jugador / menu",
        en: "Player / menu",
        items: [
          item("NoclipBind", "Tecla Noclip (VK)", "Noclip key (VK)", "int", { min: 0, max: 255 }),
          item("mnkey", "Tecla menu (VK)", "Menu key (VK)", "int", { min: 0, max: 255 }),
          item("gen_panic", "Tecla panico (VK)", "Panic key (VK)", "int", { min: 0, max: 255 }),
          item("veh_carry_bind", "Tecla lanzar coche (VK)", "Carry vehicle key (VK)", "int", { min: 0, max: 255 })
        ]
      },
      {
        es: "Quick binds (VK)",
        en: "Quick binds (VK)",
        items: [
          item("qb_visuals", "Quick: ESP", "Quick: ESP", "int", { min: 0, max: 255 }),
          item("qb_godmode", "Quick: Godmode", "Quick: Godmode", "int", { min: 0, max: 255 }),
          item("qb_invisible", "Quick: Invisible", "Quick: Invisible", "int", { min: 0, max: 255 }),
          item("qb_noclip", "Quick: Noclip", "Quick: Noclip", "int", { min: 0, max: 255 }),
          item("qb_veh_tuning", "Quick: Tuneo vehiculo", "Quick: Vehicle tuning", "int", { min: 0, max: 255 })
        ]
      },
      {
        es: "Macro strafe",
        en: "Strafe macro",
        items: [
          item("macro_strafe_start_bind", "Inicio macro (VK)", "Macro start (VK)", "int", { min: 0, max: 255 }),
          item("macro_strafe_stop_bind", "Parar macro (VK)", "Macro stop (VK)", "int", { min: 0, max: 255 })
        ]
      }
    ]
  }
];

const extraCategoryPatches = {
  visuals: [14, 15],
  misc: [16]
};

module.exports = { extraSections, extraCategoryPatches };
