public class JavaRuntimeFixture {
    public static volatile long value;
    public static void main(String[] args)throws Exception {
        System.out.println(java.lang.management.ManagementFactory.getRuntimeMXBean().getName().split("@")[0]);
        long duration=args.length==0?45000:Long.parseLong(args[0]);
        if(duration<1000||duration>4*60*60*1000)throw new IllegalArgumentException("fixture duration");
        long until=System.currentTimeMillis()+duration;
        while(System.currentTimeMillis()<until){for(int i=0;i<20000;i++)value+=i%17;Thread.sleep(10);}
    }
}
