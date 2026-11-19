/* Branchement à la base Supabase (projet « pokedash », West EU Paris).

   Ces deux valeurs sont PUBLIQUES par conception : la clé publishable ne donne
   accès à rien toute seule. Ce qui protège tes données, c'est le Row Level
   Security défini dans schema.sql — chaque compte ne voit que ses propres
   lignes, et personne n'en voit aucune sans être connecté.

   Ne mets JAMAIS ici la clé « service_role » / « secret » : celle-là contourne
   toutes les règles. */
window.POKEMARGES_CONFIG = {
  supabaseUrl: "https://zxyifgpwbpndtylmanxv.supabase.co",
  supabaseAnonKey: "sb_publishable_71ndwclyR90kfZCtoeqfTg_pJ-p3laU"
};
