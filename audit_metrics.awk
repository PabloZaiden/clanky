BEGIN{FS=""}
FNR==1{if(NR>1) print ""; print FILENAME}
{ }
END{}
