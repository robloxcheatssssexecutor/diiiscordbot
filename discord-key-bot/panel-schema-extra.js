function item(key, es, en, kind = "bool", extra = {}) {
  return { key, label: { es, en }, kind, ...extra };
}

function rgba4(prefix, esName, enName) {
  return [{ key: prefix, label: { es: esName, en: enName }, kind: "rgba" }];
}

function bindItem(key, es, en) {
  return item(key, es, en, "bind", { min: 0, max: 255 });
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
          bindItem("abt_key", "Tecla Aimbot", "Aimbot key"),
          bindItem("slt_key", "Tecla Silent", "Silent key"),
          bindItem("magic_key", "Tecla Magic", "Magic key"),
          bindItem("trg_key", "Tecla Trigger", "Trigger key")
        ]
      },
      {
        es: "Jugador / menu",
        en: "Player / menu",
        items: [
          bindItem("NoclipBind", "Tecla Noclip", "Noclip key"),
          bindItem("mnkey", "Tecla menu", "Menu key"),
          bindItem("gen_panic", "Tecla panico", "Panic key"),
          bindItem("veh_carry_bind", "Tecla lanzar coche", "Carry vehicle key")
        ]
      },
      {
        es: "Quick binds",
        en: "Quick binds",
        items: [
          bindItem("qb_visuals", "Quick: ESP", "Quick: ESP"),
          bindItem("qb_godmode", "Quick: Godmode", "Quick: Godmode"),
          bindItem("qb_invisible", "Quick: Invisible", "Quick: Invisible"),
          bindItem("qb_noclip", "Quick: Noclip", "Quick: Noclip"),
          bindItem("qb_veh_tuning", "Quick: Tuneo vehiculo", "Quick: Vehicle tuning")
        ]
      },
      {
        es: "Macro strafe",
        en: "Strafe macro",
        items: [
          bindItem("macro_strafe_start_bind", "Inicio macro", "Macro start"),
          bindItem("macro_strafe_stop_bind", "Parar macro", "Macro stop")
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
