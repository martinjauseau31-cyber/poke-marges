/* Branchement à la base Supabase.
   Ces deux valeurs sont PUBLIQUES par conception : la clé « anon » ne donne
   accès à rien toute seule. Ce qui protège tes données, c'est le Row Level
   Security défini dans schema.sql — chaque compte ne voit que ses lignes.
   Ne mets JAMAIS ici la clé « service_role » : celle-là contourne tout. */
window.POKEMARGES_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: ""
};
